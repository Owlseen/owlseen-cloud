import { beforeAll, describe, expect, it, vi } from "vitest";
import { connectionsOf, connectWithFields } from "@/application/connections";
import type { Database } from "@/infrastructure/db/client";
import { connection } from "@/infrastructure/db/schema/connections";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { atTheScreen } from "./support/at-the-screen";
import { GOOGLE_TOKEN, GOOGLE_USER, stateIn, teammate, testServices } from "./support/search";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidateTag: () => {} }));
vi.mock("@/infrastructure/auth/session", () => ({ currentSeat: async () => atTheScreen.seat }));
vi.mock("@/infrastructure/services", () => ({ appServices: () => atTheScreen.services }));

const start = (await import("@/app/api/connections/google/start/route")).GET;
const callback = (await import("@/app/api/connections/google/callback/route")).GET;

const BASE = "https://owlseen.test";
const CONSENT = "https://accounts.google.com/o/oauth2/v2/auth";

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
});

function sittingAs(workspaceId: string, userId: string, routes: Parameters<typeof testServices>[1] = [GOOGLE_TOKEN, GOOGLE_USER]) {
  atTheScreen.services = testServices(db, routes).services;
  atTheScreen.seat = { userId, workspaceId } as never;
}

/** A Google client saved on the connection's page, its access not allowed yet. */
async function clientSaved() {
  const { workspaceId, userId } = await createTestWorkspace(db);
  sittingAs(workspaceId, userId);
  const made = await connectWithFields(testServices(db, [{ ...GOOGLE_TOKEN, status: 400, json: { error: "invalid_grant" } }]).services, workspaceId, userId, "google", { clientId: "a-client.apps.googleusercontent.com", clientSecret: "a-client-secret" });
  if (!made.ok) throw new Error(made.error);
  return { workspaceId, userId, connectionId: made.connection.id };
}

const startFor = (connectionId: string) => start(new Request(`${BASE}/api/connections/google/start?connection=${connectionId}`));
const back = (query: Record<string, string>) => callback(new Request(`${BASE}/api/connections/google/callback?${new URLSearchParams(query)}`));
const landing = (response: Response) => new URL(response.headers.get("location") as string);

describe("allowing access with Google", () => {
  it("sends a manager to Google, asking for a lasting token, with this app's address and a state", async () => {
    const { connectionId } = await clientSaved();
    const response = await startFor(connectionId);
    expect(response.status).toBe(307);
    const address = landing(response);
    expect(`${address.origin}${address.pathname}`).toBe(CONSENT);
    expect(Object.fromEntries(address.searchParams)).toMatchObject({ client_id: "a-client.apps.googleusercontent.com", access_type: "offline", prompt: "consent", redirect_uri: `${BASE}/api/connections/google/callback`, response_type: "code" });
    expect(address.searchParams.get("state")).toBeTruthy();
  });

  it("sends a plain member back to the page, which says why", async () => {
    const { workspaceId, connectionId } = await clientSaved();
    sittingAs(workspaceId, await teammate(db, workspaceId));
    const address = landing(await startFor(connectionId));
    expect(address.pathname).toBe("/connections/google");
    expect(address.searchParams.get("error")).toBe("Only owners and admins can change this.");
  });

  it("sends back an address that names no connection", async () => {
    await clientSaved();
    expect(landing(await start(new Request(`${BASE}/api/connections/google/start`))).searchParams.get("error")).toBeTruthy();
  });

  it("says a connection can't be opened rather than failing, when its seal is broken", async () => {
    const { workspaceId, connectionId } = await clientSaved();
    await withWorkspace(db, workspaceId, (tx) => tx.update(connection).set({ sealedCredentials: "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA" }));
    expect(landing(await startFor(connectionId)).searchParams.get("error")).toContain("connect it again");
  });
});

describe("coming back from Google", () => {
  it("keeps the lasting token, names the connection after the account, and says so", async () => {
    const { workspaceId, connectionId } = await clientSaved();
    const state = stateIn((await startFor(connectionId)).headers.get("location") as string);
    const address = landing(await back({ code: "a-code", state }));
    expect(address.pathname).toBe("/connections/google");
    expect(address.searchParams.get("said")).toBe("Connected as ada@acme.example.");
    expect(await connectionsOf(atTheScreen.services as never, workspaceId)).toMatchObject([{ label: "ada@acme.example", status: "connected", awaitsConsent: false }]);
  });

  it("changes nothing when Google gave no code, as when someone refuses", async () => {
    const { workspaceId } = await clientSaved();
    expect(landing(await back({ error: "access_denied" })).searchParams.get("error")).toBe("Google wasn’t given access: nothing changed.");
    expect(await connectionsOf(atTheScreen.services as never, workspaceId)).toMatchObject([{ awaitsConsent: true }]);
  });

  it("refuses a state that's been altered, or that was made for someone else", async () => {
    const { workspaceId, connectionId } = await clientSaved();
    const state = stateIn((await startFor(connectionId)).headers.get("location") as string);
    expect(landing(await back({ code: "a-code", state: `${state}x` })).searchParams.get("error")).toBeTruthy();
    sittingAs(workspaceId, await teammate(db, workspaceId, "admin"));
    expect(landing(await back({ code: "a-code", state })).searchParams.get("error")).toBeTruthy();
    expect(await connectionsOf(atTheScreen.services as never, workspaceId)).toMatchObject([{ awaitsConsent: true }]);
  });

  it("says what Google says when the code doesn't work", async () => {
    const { workspaceId, userId, connectionId } = await clientSaved();
    const state = stateIn((await startFor(connectionId)).headers.get("location") as string);
    sittingAs(workspaceId, userId, [{ ...GOOGLE_TOKEN, status: 400, json: { error: "invalid_grant", error_description: "Bad code" } }]);
    expect(landing(await back({ code: "a-code", state })).searchParams.get("error")).toContain("Bad code");
  });
});
