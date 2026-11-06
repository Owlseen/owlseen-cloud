import { DAY_NOTE } from "@/application/overview";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { GET as breakdownRoute } from "@/app/api/v1/figures/breakdown/route";
import { GET as figuresRoute } from "@/app/api/v1/figures/route";
import { apiKeysOf, createApiKey, revokeApiKey } from "@/application/api-keys";
import type { Services } from "@/application/services";
import { sha256 } from "@/infrastructure/crypto/secrets";
import type { Database } from "@/infrastructure/db/client";
import { apiKey } from "@/infrastructure/db/schema/connections";
import { site } from "@/infrastructure/db/schema/search";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { followSite, storeKeyword, storePage, storeTotals, testServices } from "./support/search";

const shared = vi.hoisted(() => ({ services: undefined as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("@/infrastructure/services", () => ({ appServices: () => shared.services }));

let db: Database;
let services: Services;
beforeAll(async () => {
  db = await createTestDatabase();
  services = testServices(db).services;
  shared.services = services;
});

/** A workspace with a site, and a real key to read it with. */
async function keyed(workspaceName = "Acme", siteName = "acme.example") {
  const seat = await createTestWorkspace(db, workspaceName);
  const made = await createApiKey(db, seat.workspaceId, seat.userId, "Dashboard", ["figures:read"]);
  if (!made.ok) throw new Error(made.error);
  return { ...seat, key: made.key, keyId: made.id, site: await followSite(db, seat.workspaceId, siteName) };
}

/** A key that opens a workspace for something else: nothing makes one yet, so only the row can say so. */
async function keyWithoutTheScope(workspaceId: string) {
  const key = `sk_${crypto.randomUUID()}`;
  await withWorkspace(db, workspaceId, (tx) => tx.insert(apiKey).values({ name: "Other", keyHash: sha256(key), prefix: key.slice(0, 10), scopes: ["something:else"] }));
  return key;
}

const asking = (route: (request: Request) => Promise<Response>, path: string) => (key: string | null, query = "") => route(new Request(`https://owlseen.test${path}${query}`, { headers: key ? { authorization: `Bearer ${key}` } : {} }));
const figures = asking(figuresRoute, "/api/v1/figures");
const breakdown = asking(breakdownRoute, "/api/v1/figures/breakdown");

const quiet = (date: string) => ({ date, clicks: 0, impressions: 0, position: null, ctr: 0 });

describe.each([
  ["/api/v1/figures", figures],
  ["/api/v1/figures/breakdown", breakdown],
])("%s", (_path, call) => {
  it("answers 401 without a key, or with one nobody made", async () => {
    for (const key of [null, "", "not-even-a-key", "sk_made_up"]) {
      const refused = await call(key, "?site=11111111-1111-4111-8111-111111111111&dimension=keyword&value=acme");
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual({ error: "Missing or refused API key." });
    }
  });

  it("answers 401 for a key since revoked", async () => {
    const { workspaceId, userId, key, keyId } = await keyed();
    await revokeApiKey(db, workspaceId, userId, keyId);
    expect((await call(key)).status).toBe(401);
  });

  it("answers 403 for a key that may not read figures", async () => {
    const { workspaceId } = await keyed();
    const refused = await call(await keyWithoutTheScope(workspaceId));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "This key may not read figures." });
  });

  it("answers 400 for a site that can't be one", async () => {
    const { key } = await keyed();
    const refused = await call(key, "?site=not-an-id&dimension=keyword&value=acme");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "site is a site’s id." });
  });

  it("records that the key was used", async () => {
    const { workspaceId, key } = await keyed();
    expect((await apiKeysOf(db, workspaceId))[0].lastUsedAt).toBeNull();
    await call(key);
    expect((await apiKeysOf(db, workspaceId))[0].lastUsedAt).toBeInstanceOf(Date);
  });
});

describe("a workspace's figures", () => {
  it("come 50 sites at a time, saying when there's another page", async () => {
    const { key, workspaceId } = await keyed();
    for (let index = 0; index < 50; index += 1) await followSite(db, workspaceId, `site${String(index).padStart(2, "0")}.example`);
    const first = await (await figures(key, "?days=1")).json();
    expect(first.sites).toHaveLength(50);
    expect(first.nextPage).toBe(2);
    const second = await (await figures(key, "?days=1&page=2")).json();
    expect(second.sites).toHaveLength(1);
    expect(second.nextPage).toBeNull();
    expect(second.sites[0].name).not.toBe(first.sites[0].name);
    expect((await (await figures(key, "?days=1&page=nonsense")).json()).sites).toHaveLength(50);
    expect((await (await figures(key, "?days=1&page=9")).json()).sites).toEqual([]);
    expect((await figures(key, "?days=1&page=1e309")).status).toBe(200);
    expect((await figures(key, "?days=1&page=-3")).status).toBe(200);
  });

  it("come in the documented shape, both engines together, ctr worked out, quiet days as zeros", async () => {
    const { workspaceId, key, site: { id, name } } = await keyed();
    await storeTotals(db, workspaceId, id, "google", [{ day: "2026-11-05", clicks: 3, impressions: 60, position: 7.5 }]);
    await storeTotals(db, workspaceId, id, "bing", [{ day: "2026-11-05", clicks: 1, impressions: 20, position: null }]);
    await withWorkspace(db, workspaceId, (tx) => tx.update(site).set({ lastSyncedAt: new Date("2026-11-05T06:00:03Z") }));
    const response = await figures(key, "?days=2");
    expect(response.status).toBe(200);
    // 4 clicks of 80 impressions is 5%; the position is Google's alone.
    expect(await response.json()).toEqual({
      workspace: { id: workspaceId, name: "Acme" },
      from: "2026-11-04",
      to: "2026-11-05",
      dayNote: DAY_NOTE,
      reportedUpTo: { google: "2026-11-05", bing: "2026-11-05" },
      sites: [{ id, name, lastSyncedAt: "2026-11-05T06:00:03.000Z", days: [quiet("2026-11-04"), { date: "2026-11-05", clicks: 4, impressions: 80, position: 7.5, ctr: 0.05 }] }],
      nextPage: null,
    });
  });

  it("list every site by name, or the one asked for", async () => {
    const { workspaceId, key, site: { id } } = await keyed();
    const other = await followSite(db, workspaceId, "alpha.example");
    expect((await (await figures(key, "?days=1")).json()).sites.map(({ name }: { name: string }) => name)).toEqual(["alpha.example", "acme.example"].sort());
    expect((await (await figures(key, `?days=1&site=${other.id}`)).json()).sites.map(({ id: sent }: { id: string }) => sent)).toEqual([other.id]);
    expect((await (await figures(key, `?days=1&site=${id}`)).json()).sites.map(({ id: sent }: { id: string }) => sent)).toEqual([id]);
  });

  it.each([
    ["no days", "", 30, "2026-10-07"],
    ["one day", "?days=1", 1, "2026-11-05"],
    ["a year", "?days=365", 365, "2025-11-06"],
    ["too many days", "?days=1000", 365, "2025-11-06"],
    ["no real number", "?days=lots", 30, "2026-10-07"],
    ["zero days", "?days=0", 30, "2026-10-07"],
  ])("with %s cover the right period", async (_case, query, length, from) => {
    const { key } = await keyed();
    const answer = await (await figures(key, query)).json();
    expect(answer.from).toBe(from);
    expect(answer.to).toBe("2026-11-05");
    expect(answer.sites[0].days).toHaveLength(length);
  });

  it("show nothing of another workspace's site, and name only the key's own workspace", async () => {
    const mine = await keyed("Acme", "acme.example");
    const theirs = await keyed("Northwind", "northwind.example");
    await storeTotals(db, theirs.workspaceId, theirs.site.id, "google", [{ day: "2026-11-05", clicks: 99, impressions: 99, position: 1 }]);
    const response = await figures(mine.key, `?days=1&site=${theirs.site.id}`);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ workspace: { id: mine.workspaceId, name: "Acme" }, from: "2026-11-05", to: "2026-11-05", dayNote: DAY_NOTE, reportedUpTo: {}, sites: [], nextPage: null });
    expect(text).not.toContain("northwind");
    expect(await (await figures(mine.key, "?days=1")).text()).not.toContain("northwind");
  });
});

describe("one keyword's or one page's figures", () => {
  const DAY = { day: "2026-11-05", clicks: 3, impressions: 60, position: 7.5 };
  const named = (siteId: string, dimension: string, value: string, days = 2) => `?site=${siteId}&dimension=${dimension}&value=${encodeURIComponent(value)}&days=${days}`;

  it("come per day for a keyword named, ctr worked out, quiet days as zeros", async () => {
    const { workspaceId, key, site: { id, name } } = await keyed();
    await storeKeyword(db, workspaceId, id, "acme pricing", [DAY, { ...DAY, day: "2026-10-01", clicks: 99 }]);
    const response = await breakdown(key, named(id, "keyword", "acme pricing"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ site: { id, name }, dimension: "keyword", value: "acme pricing", from: "2026-11-04", to: "2026-11-05", dayNote: DAY_NOTE, days: [quiet("2026-11-04"), { date: "2026-11-05", clicks: 3, impressions: 60, position: 7.5, ctr: 0.05 }] });
  });

  it("come the same way for a page named", async () => {
    const { workspaceId, key, site: { id } } = await keyed();
    await storePage(db, workspaceId, id, "https://acme.example/pricing", [DAY]);
    const answer = await (await breakdown(key, named(id, "page", "https://acme.example/pricing", 1))).json();
    expect(answer).toMatchObject({ dimension: "page", value: "https://acme.example/pricing", days: [{ date: "2026-11-05", clicks: 3, impressions: 60, position: 7.5, ctr: 0.05 }] });
  });

  it("are all zeros for what was never seen: a caller learns nothing it didn't say", async () => {
    const { key, site: { id } } = await keyed();
    const answer = await (await breakdown(key, named(id, "keyword", "never searched", 1))).json();
    expect(answer.days).toEqual([quiet("2026-11-05")]);
  });

  it("don't mix up two sites' same words", async () => {
    const { workspaceId, key, site: { id } } = await keyed();
    const other = await followSite(db, workspaceId, "alpha.example");
    await storeKeyword(db, workspaceId, id, "same words", [DAY]);
    await storeKeyword(db, workspaceId, other.id, "same words", [{ ...DAY, clicks: 9 }]);
    expect((await (await breakdown(key, named(other.id, "keyword", "same words", 1))).json()).days[0].clicks).toBe(9);
  });

  it("answer 400 for another dimension, or no value", async () => {
    const { key, site: { id } } = await keyed();
    const dimensionOrValue = { error: "dimension is keyword or page, and value names one." };
    for (const query of [`?site=${id}&dimension=country&value=fr`, `?site=${id}&value=acme`, `?site=${id}&dimension=keyword`, `?site=${id}&dimension=keyword&value=`]) {
      const refused = await breakdown(key, query);
      expect(refused.status, query).toBe(400);
      expect(await refused.json()).toEqual(dimensionOrValue);
    }
  });

  it("answer 400 with no site at all", async () => {
    const { key } = await keyed();
    expect((await breakdown(key, "?dimension=keyword&value=acme")).status).toBe(400);
  });

  it("answer 404 for another workspace's site, as for one that was never there", async () => {
    const mine = await keyed("Acme", "acme.example");
    const theirs = await keyed("Northwind", "northwind.example");
    await storeKeyword(db, theirs.workspaceId, theirs.site.id, "theirs", [DAY]);
    for (const siteId of [theirs.site.id, crypto.randomUUID()]) {
      const refused = await breakdown(mine.key, named(siteId, "keyword", "theirs"));
      expect(refused.status).toBe(404);
      expect(await refused.json()).toEqual({ error: "There’s no such site in this workspace." });
    }
  });
});
