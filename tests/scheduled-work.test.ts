import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/cron/sync/route";
import { finishGoogleConsent, startGoogleConsent } from "@/application/google-consent";
import { connectWithFields } from "@/application/connections";
import { whatIsScheduled } from "@/application/scheduled-work";
import { addSites, removeSite } from "@/application/sites";
import type { Database } from "@/infrastructure/db/client";
import { site } from "@/infrastructure/db/schema/search";
import { SCHEDULED_WORK_TAG, scheduledWorkChanged } from "@/infrastructure/scheduling/scheduled-work";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { connectGoogle, followSite, GOOGLE_TOKEN, googleProperty, HEALTHY_ACCOUNTS, INSPECT, inspected, NOW, stateIn, storePage, testServices } from "./support/search";

const revalidateTag = vi.hoisted(() => vi.fn());
const shared = vi.hoisted(() => ({ db: undefined as unknown, services: undefined as unknown, secret: "cron-secret" as string | undefined }));
vi.mock("next/cache", () => ({ revalidateTag, cacheLife: () => {}, cacheTag: () => {} }));
vi.mock("server-only", () => ({}));
vi.mock("@/infrastructure/db/client", async (original) => ({ ...(await original<typeof import("@/infrastructure/db/client")>()), db: () => shared.db }));
vi.mock("@/infrastructure/env", async (original) => ({ ...(await original<typeof import("@/infrastructure/env")>()), env: () => ({ CRON_SECRET: shared.secret }) }));
vi.mock("@/infrastructure/services", () => ({ appServices: () => shared.services }));

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
  shared.db = db;
});
beforeEach(async () => {
  revalidateTag.mockReset();
  shared.secret = "cron-secret";
  shared.services = testServices(db, []).services;
  await db.delete(site);
});

describe("what the scheduled job has to do", () => {
  it("is nothing with no site anywhere", async () => {
    expect(await whatIsScheduled(db)).toEqual({ hasSites: false });
  });

  it("is something once there's a site, in any workspace", async () => {
    const { workspaceId } = await createTestWorkspace(db);
    await followSite(db, workspaceId);
    expect(await whatIsScheduled(db)).toEqual({ hasSites: true });
    const other = await createTestWorkspace(db, "Other");
    await followSite(db, other.workspaceId, "northwind.example");
    expect(await whatIsScheduled(db)).toEqual({ hasSites: true });
  });

  it("is nothing again once the last site goes", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const row = await followSite(db, workspaceId);
    await removeSite(testServices(db).services, workspaceId, userId, row.id);
    expect(await whatIsScheduled(db)).toEqual({ hasSites: false });
  });
});

describe("what's known about it", () => {
  it("is cleared at once, so a run started right after doesn't read the old answer", () => {
    scheduledWorkChanged();
    expect(revalidateTag).toHaveBeenCalledWith(SCHEDULED_WORK_TAG, { expire: 0 });
  });

  it("doesn't stop anything outside a request, where nothing is cached to clear", () => {
    revalidateTag.mockImplementation(() => {
      throw new Error("Invariant: static generation store missing");
    });
    expect(() => scheduledWorkChanged()).not.toThrow();
  });

  it("is cleared by whatever gives the job work or takes it away", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { services } = testServices(db);
    const made = await connectWithFields(services, workspaceId, userId, "google", { clientId: "a-client", clientSecret: "a-secret" });
    if (!made.ok) throw new Error(made.error);
    const started = await startGoogleConsent(services, workspaceId, userId, made.connection.id);
    if ("error" in started) throw new Error(started.error);
    revalidateTag.mockClear();
    await finishGoogleConsent(services, stateIn(started.address), "a-code", userId);
    expect(revalidateTag).toHaveBeenCalledTimes(1);
    revalidateTag.mockClear();
    await addSites(services, workspaceId, userId, ["acme.example"]);
    expect(revalidateTag).toHaveBeenCalledTimes(1);
    revalidateTag.mockClear();
    const [{ id }] = await db.select({ id: site.id }).from(site);
    await removeSite(services, workspaceId, userId, id);
    expect(revalidateTag).toHaveBeenCalledTimes(1);
  });

  it("isn't cleared by what was refused", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { services } = testServices(db);
    revalidateTag.mockClear();
    await addSites(services, workspaceId, userId, ["nothing-connected.example"]);
    await removeSite(services, workspaceId, userId, crypto.randomUUID());
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});

describe("the job's address", () => {
  const call = (authorization?: string) => GET(new Request("https://owlseen.test/api/cron/sync", { headers: authorization ? { authorization } : {} }));

  it("answers 401 without the secret, and asks nothing", async () => {
    const { services, calls } = testServices(db);
    shared.services = services;
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect((await call("cron-secret-but-longer")).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("answers 401 to everyone when no secret is set, an empty one included", async () => {
    shared.secret = undefined;
    expect((await call("Bearer anything")).status).toBe(401);
    expect((await call("Bearer ")).status).toBe(401);
    shared.secret = "";
    expect((await call("Bearer ")).status).toBe(401);
  });

  it("has nothing to do with no site, and reads nothing", async () => {
    const { services, calls } = testServices(db, HEALTHY_ACCOUNTS);
    shared.services = services;
    const response = await call("Bearer cron-secret");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ idle: true });
    expect(calls).toEqual([]);
  });

  it("reads what's due, then asks about pages with what's left, and reports both", async () => {
    const seat = await createTestWorkspace(db);
    await connectGoogle(testServices(db).services, seat.workspaceId, seat.userId);
    const row = await followSite(db, seat.workspaceId);
    await storePage(db, seat.workspaceId, row.id, "https://acme.example/pricing");
    shared.services = testServices(db, [...googleProperty("sc-domain:acme.example"), GOOGLE_TOKEN, { match: INSPECT, json: inspected("PASS") }], NOW).services;
    const response = await call("Bearer cron-secret");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sync: { synced: 1, failed: 0, left: 0 }, indexing: { checked: 1, failed: 0, left: 0 } });
  });
});
