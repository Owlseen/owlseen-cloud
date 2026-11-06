import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tryCheck } from "@/application/connection-use";
import { checkConnection, connectionsOf, connectionsWith, connectorsOffered, connectWithFields, disconnect, markFailing } from "@/application/connections";
import { finishGoogleConsent, googleRedirectAddress, startGoogleConsent } from "@/application/google-consent";
import type { Services } from "@/application/services";
import { changeRole } from "@/application/team";
import { connectorOf, readFields, type Connector } from "@/domain/connectors";
import { NOT_A_MANAGER_OF_SETTINGS } from "@/domain/team";
import { open } from "@/infrastructure/crypto/secrets";
import type { Database } from "@/infrastructure/db/client";
import { connection } from "@/infrastructure/db/schema/connections";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import type { FakeRoute } from "./support/fetch";
import { BING_SITES, bingSites, connectBing, connectGoogle, followSite, GOOGLE_SITES, GOOGLE_TOKEN, GOOGLE_USER, NOW, SECRETS_KEY, stateIn, teammate, testServices, testSettings } from "./support/search";

const GOOGLE_FIELDS = { clientId: "a-client.apps.googleusercontent.com", clientSecret: "a-client-secret" };
const MINUTE = 60_000;

let db: Database;
let services: Services;
beforeAll(async () => {
  db = await createTestDatabase();
  services = testServices(db).services;
});

const rowsIn = (workspaceId: string) => withWorkspace(db, workspaceId, (tx) => tx.select().from(connection));
const rowOf = async (workspaceId: string, id: string) => (await withWorkspace(db, workspaceId, (tx) => tx.select().from(connection).where(eq(connection.id, id))))[0];
const at = (moment: Date, on: Services = services): Services => ({ ...on, now: () => moment });

/** A Google client saved, and the consent started: what's left is for the member to come back from Google. */
async function awaitingConsent(seat?: { workspaceId: string; userId: string }) {
  const { workspaceId, userId } = seat ?? (await createTestWorkspace(db));
  const made = await connectWithFields(services, workspaceId, userId, "google", GOOGLE_FIELDS);
  if (!made.ok) throw new Error(made.error);
  const started = await startGoogleConsent(services, workspaceId, userId, made.connection.id);
  if ("error" in started) throw new Error(started.error);
  return { workspaceId, userId, id: made.connection.id, address: started.address, state: stateIn(started.address) };
}

describe("the catalogue", () => {
  it("offers Google and Bing, with what each gives", () => {
    expect(connectorsOffered().map(({ kind, name, capabilities }) => ({ kind, name, capabilities }))).toEqual([
      { kind: "google", name: "Google Search Console", capabilities: ["search_figures", "keywords_and_pages", "index_status", "sitemaps"] },
      { kind: "bing", name: "Bing Webmaster Tools", capabilities: ["search_figures", "sitemaps"] },
    ]);
  });

  it("seals every field either asks for, and only Google asks a member to allow access", () => {
    for (const connector of connectorsOffered()) for (const field of connector.fields) expect(field.secret, field.key).toBe(true);
    expect(connectorOf("google")?.consentCallback).toBe("/api/connections/google/callback");
    expect(connectorOf("bing")?.consentCallback).toBeUndefined();
  });

  it("knows nothing else", () => {
    expect(connectorOf("yahoo")).toBeUndefined();
  });

  it("gives Google the redirect address on this instance", () => {
    expect(googleRedirectAddress(services)).toBe("https://owlseen.test/api/connections/google/callback");
  });
});

describe("what was typed", () => {
  const connector: Connector = { kind: "bing", name: "Test", summary: "", capabilities: [], hosting: "US", setup: [], fields: [{ key: "key", label: "Key", secret: true }, { key: "note", label: "Note", secret: false, optional: true }] };

  it("is trimmed, and an empty optional field stays out so it doesn't overwrite what's saved", () => {
    expect(readFields(connector, { key: "  abc  ", note: "   " })).toEqual({ ok: true, values: { key: "abc" } });
    expect(readFields(connector, { key: "abc", note: "kept" })).toEqual({ ok: true, values: { key: "abc", note: "kept" } });
  });

  it("names what's missing, a field that isn't text included", () => {
    expect(readFields(connector, {})).toEqual({ ok: false, missing: ["Key"] });
    expect(readFields(connector, { key: 42 })).toEqual({ ok: false, missing: ["Key"] });
  });
});

describe("connecting Bing", () => {
  it("asks Bing with the key first, and shows a member no credentials", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { services: checking, calls } = testServices(db, [BING_SITES]);
    const made = await connectWithFields(checking, workspaceId, userId, "bing", { apiKey: "  a-bing-key  " });
    expect(calls.map(({ method, url }) => [method, new URL(url).pathname, new URL(url).searchParams.get("apikey")])).toEqual([["GET", "/webmaster/api.svc/json/GetUserSites", "a-bing-key"]]);
    expect(made).toEqual({ ok: true, connection: { id: expect.any(String), kind: "bing", name: "Bing Webmaster Tools", label: "Bing Webmaster Tools", status: "connected", capabilities: ["search_figures", "sitemaps"], checkedAt: NOW, lastError: null, awaitsConsent: false } });
    expect(JSON.stringify(await connectionsOf(checking, workspaceId))).not.toContain("a-bing-key");
  });

  it("seals the key in its row, so the raw key never appears in the column", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { id } = await connectBing(services, workspaceId, userId);
    const row = await rowOf(workspaceId, id);
    expect(row.sealedCredentials).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain("a-bing-key");
    expect(row.settings).toEqual({});
    expect(row.connectedBy).toBe(userId);
    expect(open(row.sealedCredentials, SECRETS_KEY)).toEqual({ apiKey: "a-bing-key" });
  });

  it("says what's wrong when Bing answers as it does to a key it doesn't know", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { services } = testServices(db, [{ match: "GET https://ssl.bing.com/webmaster/api.svc/json/GetUserSites", status: 400, json: { ErrorCode: 3, Message: "ERROR!!! InvalidApiKey" } }]);
    expect(await connectWithFields(services, workspaceId, userId, "bing", { apiKey: "a-key" })).toEqual({ ok: false, error: "Bing refused this key. Check it in Bing Webmaster Tools, under Settings, API Access." });
  });

  it("saves nothing when Bing refuses the key, and says Bing's words", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { services: refusing } = testServices(db, [{ ...BING_SITES, status: 401, json: { message: "Invalid API key" } }]);
    expect(await connectWithFields(refusing, workspaceId, userId, "bing", { apiKey: "wrong" })).toEqual({ ok: false, error: "Bing refused the credentials: Invalid API key" });
    expect(await rowsIn(workspaceId)).toEqual([]);
  });

  it("saves nothing when Bing can't be reached, saying so in plain words", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { services: nowhere } = testServices(db, []);
    expect(await connectWithFields(nowhere, workspaceId, userId, "bing", { apiKey: "a-bing-key" })).toEqual({ ok: false, error: "Bing couldn’t be reached." });
    expect(await rowsIn(workspaceId)).toEqual([]);
  });

  it("asks nothing when a field is missing or the service unknown", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { services: checking, calls } = testServices(db);
    expect(await connectWithFields(checking, workspaceId, userId, "bing", { apiKey: "   " })).toEqual({ ok: false, error: "Missing: API key." });
    expect(await connectWithFields(checking, workspaceId, userId, "yahoo", {})).toEqual({ ok: false, error: "There’s no such service." });
    expect(calls).toEqual([]);
    expect(await rowsIn(workspaceId)).toEqual([]);
  });

  it("refuses to save what it couldn't seal, before asking anyone", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { services: unsealed, calls } = testServices(db);
    const made = await connectWithFields({ ...unsealed, settings: { ...testSettings, OWLSEEN_SECRETS_KEY: undefined } }, workspaceId, userId, "bing", { apiKey: "a-bing-key" });
    expect(made).toMatchObject({ ok: false, error: expect.stringContaining("OWLSEEN_SECRETS_KEY") });
    expect(calls).toEqual([]);
  });

  it("keeps the row when the key is typed again, however many sites the account has by then", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const first = await connectBing(services, workspaceId, userId);
    const { services: grown } = testServices(db, [bingSites("https://www.acme.example/", "https://www.northwind.example/")]);
    const again = await connectWithFields(grown, workspaceId, userId, "bing", { apiKey: "a-new-key" });
    expect(again).toMatchObject({ ok: true, connection: { id: first.id } });
    const rows = await rowsIn(workspaceId);
    expect(rows).toHaveLength(1);
    expect(open(rows[0].sealedCredentials, SECRETS_KEY)).toEqual({ apiKey: "a-new-key" });
  });
});

describe("who may connect", () => {
  it.each(["owner", "admin"] as const)("is an %s", async (role) => {
    const { workspaceId } = await createTestWorkspace(db);
    const asker = await teammate(db, workspaceId, role);
    expect((await connectWithFields(services, workspaceId, asker, "bing", { apiKey: "a-bing-key" })).ok).toBe(true);
  });

  it("isn't a plain member or someone from elsewhere: they're refused before anything is asked", async () => {
    const { workspaceId } = await createTestWorkspace(db);
    const { userId: outsider } = await createTestWorkspace(db, "Elsewhere");
    const { services: checking, calls } = testServices(db);
    for (const asker of [await teammate(db, workspaceId), outsider]) {
      expect(await connectWithFields(checking, workspaceId, asker, "bing", { apiKey: "a-bing-key" })).toEqual({ ok: false, error: NOT_A_MANAGER_OF_SETTINGS });
    }
    expect(calls).toEqual([]);
    expect(await rowsIn(workspaceId)).toEqual([]);
  });
});

describe("connecting Google", () => {
  it("takes a client Google says only the token is wrong for", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { services: goodClient, calls } = testServices(db, [{ ...GOOGLE_TOKEN, status: 400, json: { error: "invalid_grant", error_description: "Bad Request" } }]);
    const made = await connectWithFields(goodClient, workspaceId, userId, "google", GOOGLE_FIELDS);
    expect(made).toMatchObject({ ok: true, connection: { kind: "google", label: "Google Search Console", awaitsConsent: true } });
    const asked = new URLSearchParams(calls[0].body);
    expect(asked.get("client_id")).toBe(GOOGLE_FIELDS.clientId);
    expect(asked.get("grant_type")).toBe("refresh_token");
  });

  it("saves nothing when Google refuses the client", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { services: refusing } = testServices(db, [{ ...GOOGLE_TOKEN, status: 401, json: { error: "invalid_client", error_description: "The OAuth client was not found." } }]);
    expect(await connectWithFields(refusing, workspaceId, userId, "google", GOOGLE_FIELDS)).toEqual({ ok: false, error: "Google refused this client. Check its ID and secret." });
    expect(await rowsIn(workspaceId)).toEqual([]);
  });

  it("saves nothing when Google is down, and doesn't blame the client", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { services: down } = testServices(db, [{ ...GOOGLE_TOKEN, status: 503, json: { message: "Try later" } }]);
    expect(await connectWithFields(down, workspaceId, userId, "google", GOOGLE_FIELDS)).toEqual({ ok: false, error: "Google isn’t answering properly right now: Try later" });
    expect(await rowsIn(workspaceId)).toEqual([]);
  });

  it("wants both fields", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    expect(await connectWithFields(services, workspaceId, userId, "google", { clientId: "only-this" })).toEqual({ ok: false, error: "Missing: Client secret." });
  });

  it("awaits consent until allowed, and nothing reads through it till then", async () => {
    const { workspaceId, id, state, userId } = await awaitingConsent();
    expect((await connectionsOf(services, workspaceId))[0]).toMatchObject({ id, awaitsConsent: true });
    expect(await connectionsWith(services, workspaceId, "search_figures")).toEqual([]);
    expect(await finishGoogleConsent(services, state, "a-code", userId)).toEqual({ ok: true, said: "Connected as ada@acme.example." });
    expect((await connectionsOf(services, workspaceId))[0]).toMatchObject({ id, label: "ada@acme.example", status: "connected", awaitsConsent: false, checkedAt: NOW });
    expect((await connectionsWith(services, workspaceId, "search_figures")).map(({ row }) => row.id)).toEqual([id]);
  });

  it("seals the client and the lasting token: neither appears in the row", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { id } = await connectGoogle(services, workspaceId, userId);
    const row = await rowOf(workspaceId, id);
    for (const secret of ["a-client-secret", "a-refresh-token", GOOGLE_FIELDS.clientId]) expect(JSON.stringify(row)).not.toContain(secret);
    expect(open(row.sealedCredentials, SECRETS_KEY)).toEqual({ ...GOOGLE_FIELDS, refreshToken: "a-refresh-token", account: "ada@acme.example" });
  });

  it("replaces the connection when the same account allows access through a new client", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    await connectGoogle(services, workspaceId, userId);
    const replacing = await connectGoogle(services, workspaceId, userId);
    expect((await connectionsOf(services, workspaceId)).map(({ id, label, awaitsConsent }) => ({ id, label, awaitsConsent }))).toEqual([{ id: replacing.id, label: "ada@acme.example", awaitsConsent: false }]);
  });

  it("keeps two accounts as two connections", async () => {
    const seat = await createTestWorkspace(db);
    await connectGoogle(services, seat.workspaceId, seat.userId);
    const { services: otherAccount } = testServices(db, [{ ...GOOGLE_USER, json: { email: "bea@acme.example" } }, GOOGLE_TOKEN]);
    await connectGoogle(otherAccount, seat.workspaceId, seat.userId);
    expect((await connectionsOf(services, seat.workspaceId)).map(({ label }) => label)).toEqual(["ada@acme.example", "bea@acme.example"]);
  });
});

describe("the consent address", () => {
  it("asks Google for a lasting token, on this client, coming back here", async () => {
    const { address } = await awaitingConsent();
    const asked = new URL(address);
    expect(asked.origin + asked.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({ client_id: GOOGLE_FIELDS.clientId, redirect_uri: "https://owlseen.test/api/connections/google/callback", response_type: "code", access_type: "offline", prompt: "consent", scope: "https://www.googleapis.com/auth/webmasters openid email" });
  });

  it("is for those who manage the workspace", async () => {
    const { workspaceId, id } = await awaitingConsent();
    const plain = await teammate(db, workspaceId);
    expect(await startGoogleConsent(services, workspaceId, plain, id)).toEqual({ error: NOT_A_MANAGER_OF_SETTINGS });
  });

  it("is only for a Google connection of this workspace", async () => {
    const seat = await createTestWorkspace(db);
    const bing = await connectBing(services, seat.workspaceId, seat.userId);
    const theirs = await awaitingConsent();
    const gone = { error: "This connection no longer exists." };
    expect(await startGoogleConsent(services, seat.workspaceId, seat.userId, bing.id)).toEqual(gone);
    expect(await startGoogleConsent(services, seat.workspaceId, seat.userId, theirs.id)).toEqual(gone);
    expect(await startGoogleConsent(services, seat.workspaceId, seat.userId, crypto.randomUUID())).toEqual(gone);
  });

  it("says the same when the address names something that can't be a connection", async () => {
    const seat = await createTestWorkspace(db);
    for (const id of ["", "not-an-id"]) expect(await startGoogleConsent(services, seat.workspaceId, seat.userId, id)).toEqual({ error: "This connection no longer exists." });
  });
});

describe("the consent state", () => {
  const stillAwaiting = async (workspaceId: string) => expect((await connectionsOf(services, workspaceId))[0]).toMatchObject({ awaitsConsent: true });
  const expired = { ok: false, error: "That took too long, or came from somewhere else. Try again from the connection’s page." };

  it("can't be altered: a changed signature or a changed body is refused", async () => {
    const { workspaceId, userId, state } = await awaitingConsent();
    const [body, signature] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), expiresAt: NOW.getTime() + 3_600_000 })).toString("base64url");
    for (const altered of [`${forged}.${signature}`, `${body}.${signature.slice(0, -2)}xx`, body, "", "not.a-state"]) expect(await finishGoogleConsent(services, altered, "a-code", userId)).toEqual(expired);
    await stillAwaiting(workspaceId);
  });

  it("lasts 15 minutes and no longer", async () => {
    const { workspaceId, userId, state } = await awaitingConsent();
    expect(await finishGoogleConsent(at(new Date(NOW.getTime() + 15 * MINUTE)), state, "a-code", userId)).toEqual(expired);
    await stillAwaiting(workspaceId);
    expect((await finishGoogleConsent(at(new Date(NOW.getTime() + 15 * MINUTE - 1)), state, "a-code", userId)).ok).toBe(true);
  });

  it("only works for the member who started it, even another manager of the workspace", async () => {
    const { workspaceId, state } = await awaitingConsent();
    const admin = await teammate(db, workspaceId, "admin");
    expect(await finishGoogleConsent(services, state, "a-code", admin)).toEqual(expired);
    await stillAwaiting(workspaceId);
  });

  it("stops working for someone who no longer manages the workspace", async () => {
    const seat = await createTestWorkspace(db);
    const admin = await teammate(db, seat.workspaceId, "admin");
    const { state, workspaceId } = await awaitingConsent({ workspaceId: seat.workspaceId, userId: admin });
    await changeRole(db, seat.workspaceId, seat.userId, admin, "member");
    expect(await finishGoogleConsent(services, state, "a-code", admin)).toEqual({ ok: false, error: NOT_A_MANAGER_OF_SETTINGS });
    await stillAwaiting(workspaceId);
  });

  it("says when the connection went meanwhile", async () => {
    const { workspaceId, userId, id, state } = await awaitingConsent();
    await disconnect(services, workspaceId, userId, id);
    expect(await finishGoogleConsent(services, state, "a-code", userId)).toEqual({ ok: false, error: "This connection no longer exists." });
  });

  it("says when Google gives no lasting token, and leaves the connection waiting", async () => {
    const { workspaceId, userId, state } = await awaitingConsent();
    const { services: stingy } = testServices(db, [{ ...GOOGLE_TOKEN, json: { access_token: "an-access-token" } }]);
    expect(await finishGoogleConsent(stingy, state, "a-code", userId)).toMatchObject({ ok: false, error: expect.stringContaining("lasting token") });
    await stillAwaiting(workspaceId);
  });

  it("says when Google refuses the code", async () => {
    const { userId, state } = await awaitingConsent();
    const { services: refusing } = testServices(db, [{ ...GOOGLE_TOKEN, status: 400, json: { error: "invalid_grant", error_description: "Code already used" } }]);
    expect(await finishGoogleConsent(refusing, state, "a-code", userId)).toEqual({ ok: false, error: "Google refused the request: Code already used" });
  });

  it("keeps the connection's name when Google won't say whose account it is", async () => {
    const { workspaceId, userId, state } = await awaitingConsent();
    const { services: anonymous } = testServices(db, [GOOGLE_TOKEN, { ...GOOGLE_USER, status: 500, json: {} }]);
    expect(await finishGoogleConsent(anonymous, state, "a-code", userId)).toEqual({ ok: true, said: "Connected as Google Search Console." });
    expect((await connectionsOf(services, workspaceId))[0]).toMatchObject({ label: "Google Search Console", awaitsConsent: false });
  });
});

describe("checking a connection", () => {
  const LATER = new Date(NOW.getTime() + 3_600_000);
  const refusedBing: FakeRoute[] = [{ ...BING_SITES, status: 401, json: { message: "Key ended" } }];

  it("records a refusal, and then that it's back", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { id } = await connectBing(services, workspaceId, userId);
    expect(await checkConnection(at(LATER, testServices(db, refusedBing).services), workspaceId, id)).toMatchObject({ status: "failing", lastError: "Bing refused the credentials: Key ended", checkedAt: LATER });
    expect(await checkConnection(services, workspaceId, id)).toMatchObject({ status: "connected", lastError: null, checkedAt: NOW });
  });

  it("asks Google with the lasting token, and counts its properties", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { id } = await connectGoogle(services, workspaceId, userId);
    const { services: asking, calls } = testServices(db, [GOOGLE_TOKEN, GOOGLE_SITES]);
    expect(await tryCheck(asking, workspaceId, userId, id)).toEqual({ ok: true, said: "ada@acme.example answers." });
    expect(new URLSearchParams(calls[0].body).get("refresh_token")).toBe("a-refresh-token");
    expect(calls[1].headers.get("authorization")).toBe("Bearer an-access-token");
  });

  it("says why it failed, in the member's words", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { id } = await connectBing(services, workspaceId, userId);
    expect(await tryCheck(testServices(db, refusedBing).services, workspaceId, userId, id)).toEqual({ ok: false, error: "Bing refused the credentials: Key ended" });
  });

  it("knows nothing of another workspace's connection", async () => {
    const mine = await createTestWorkspace(db);
    const theirs = await createTestWorkspace(db, "Theirs");
    const { id } = await connectBing(services, theirs.workspaceId, theirs.userId);
    expect(await checkConnection(services, mine.workspaceId, id)).toBeNull();
    expect(await tryCheck(services, mine.workspaceId, mine.userId, id)).toEqual({ ok: false, error: "This connection no longer exists." });
  });

  it("is told by a read that a key was refused", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { id } = await connectBing(services, workspaceId, userId);
    await markFailing(services, workspaceId, id, "Bing refused the credentials.");
    expect((await connectionsOf(services, workspaceId))[0]).toMatchObject({ status: "failing", lastError: "Bing refused the credentials." });
    expect((await connectionsWith(services, workspaceId, "search_figures")).map(({ row }) => row.id)).toEqual([id]);
  });
});

describe("what a connection can do", () => {
  it("decides who is asked: Bing has no index status", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    await connectBing(services, workspaceId, userId);
    expect(await connectionsWith(services, workspaceId, "index_status")).toEqual([]);
    expect(await connectionsWith(services, workspaceId, "sitemaps")).toHaveLength(1);
  });
});

describe("disconnecting", () => {
  it("forgets the connection and its credentials, and what it brought in stays", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { id } = await connectBing(services, workspaceId, userId);
    await followSite(db, workspaceId);
    expect(await disconnect(services, workspaceId, userId, id)).toBe(true);
    expect(await rowsIn(workspaceId)).toEqual([]);
    expect(await disconnect(services, workspaceId, userId, id)).toBe(false);
  });

  it("is refused to a plain member, and changes nothing", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { id } = await connectBing(services, workspaceId, userId);
    expect(await disconnect(services, workspaceId, await teammate(db, workspaceId), id)).toBe(false);
    expect(await rowsIn(workspaceId)).toHaveLength(1);
  });

  it("can't reach another workspace's connection", async () => {
    const mine = await createTestWorkspace(db);
    const theirs = await createTestWorkspace(db, "Theirs");
    const { id } = await connectBing(services, theirs.workspaceId, theirs.userId);
    expect(await disconnect(services, mine.workspaceId, mine.userId, id)).toBe(false);
    expect(await rowsIn(theirs.workspaceId)).toHaveLength(1);
  });
});

describe("a connection whose seal won't open", () => {
  const BROKEN = "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA";
  const CANT_OPEN = "These credentials can’t be opened here: connect it again.";

  async function broken() {
    const seat = await createTestWorkspace(db);
    const { id } = await connectBing(services, seat.workspaceId, seat.userId);
    await withWorkspace(db, seat.workspaceId, (tx) => tx.update(connection).set({ sealedCredentials: BROKEN }));
    return { ...seat, id };
  }

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("shows on its page as failing, and why, rather than stopping the page", async () => {
    const { workspaceId } = await broken();
    expect(await connectionsOf(services, workspaceId)).toMatchObject([{ status: "failing", lastError: CANT_OPEN, awaitsConsent: false }]);
  });

  it("is left out of what's used, and marked", async () => {
    const { workspaceId } = await broken();
    expect(await connectionsWith(services, workspaceId, "search_figures")).toEqual([]);
    const [row] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(connection));
    expect(row).toMatchObject({ status: "failing", lastError: CANT_OPEN });
  });

  it("says so when checked", async () => {
    const { workspaceId, id } = await broken();
    expect(await checkConnection(services, workspaceId, id)).toMatchObject({ status: "failing", lastError: CANT_OPEN });
  });

  it("is mended by connecting again", async () => {
    const { workspaceId, userId } = await broken();
    expect((await connectWithFields(services, workspaceId, userId, "bing", { apiKey: "a-bing-key" })).ok).toBe(true);
    expect(await connectionsOf(services, workspaceId)).toMatchObject([{ status: "connected", lastError: null }]);
  });

  it("logs that it couldn't be opened, naming the row and no value", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    logged.mockClear();
    const { workspaceId, id } = await broken();
    await connectionsOf(services, workspaceId);
    expect(logged.mock.calls[0][0]).toContain(`Opening connection ${id}`);
  });
});

describe("checking a connection", () => {
  it("is for whoever manages the workspace, and asks the service nothing otherwise", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { id } = await connectBing(services, workspaceId, userId);
    const { services: asking, calls } = testServices(db, [BING_SITES]);
    expect(await tryCheck(asking, workspaceId, await teammate(db, workspaceId), id)).toEqual({ ok: false, error: NOT_A_MANAGER_OF_SETTINGS });
    expect(calls).toEqual([]);
  });
});
