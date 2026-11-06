import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { accessOfKey, apiKeysOf } from "@/application/api-keys";
import { connectionsOf } from "@/application/connections";
import { invitationPath, inviteToWorkspace, openInvitationsOf } from "@/application/invitations";
import { siteGroupsOf } from "@/application/site-groups";
import { sitesOf } from "@/application/sites";
import { teamOf } from "@/application/team";
import { trackedKeywordsOf, trackKeyword } from "@/application/rank-tracker";
import { periodEndingAt } from "@/application/time-range";
import { HOME } from "@/domain/safe-next";
import { NOT_A_MANAGER_OF_SETTINGS } from "@/domain/team";
import type { Database } from "@/infrastructure/db/client";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { atTheScreen, form, Redirected, whereItGoes } from "./support/at-the-screen";
import { BING_SITES, connectBing, connectGoogle, followSite, GOOGLE_SITES, GOOGLE_TOKEN, googleSitemapAddress, INSPECT, inspected, NOW, storeKeyword, teammate, testServices } from "./support/search";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => atTheScreen.revalidated.push(path), revalidateTag: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
}));
vi.mock("@/infrastructure/auth/session", () => ({
  currentSeat: async () => atTheScreen.seat,
  currentMember: async () => atTheScreen.member,
  enterWorkspace: async (id: string) => void atTheScreen.entered.push(id),
  forgetWorkspace: async () => {
    atTheScreen.forgotten += 1;
  },
}));
vi.mock("@/infrastructure/services", () => ({ appServices: () => atTheScreen.services }));
vi.mock("@/infrastructure/db/client", async (original) => ({ ...(await original<typeof import("@/infrastructure/db/client")>()), db: () => atTheScreen.db }));

const { createKeyAction, revokeKeyAction } = await import("@/app/keys/actions");
const { inspectAction, submitSitemapAction } = await import("@/app/indexing/actions");
const { cancelInvitationAction, changeRoleAction, inviteAction, leaveWorkspaceAction, removeMemberAction } = await import("@/app/settings/team-actions");
const { trackAction, untrackAction } = await import("@/app/rank-tracker/actions");
const { addSitesAction, removeGroupAction, removeSiteAction, saveGroupAction } = await import("@/app/sites/actions");
const { checkAction, connectAction, disconnectAction } = await import("@/app/connections/actions");
const { joinAction } = await import("@/app/join/[token]/actions");

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
  atTheScreen.db = db;
});
beforeEach(() => {
  atTheScreen.revalidated.length = 0;
  atTheScreen.entered.length = 0;
  atTheScreen.forgotten = 0;
});

/** Someone at the screen, in this workspace, with the network answering these. */
function sittingAs(workspaceId: string, userId: string, routes: Parameters<typeof testServices>[1] = []) {
  const { services, calls } = testServices(db, routes);
  atTheScreen.services = services;
  atTheScreen.seat = { userId, name: "Ada", email: "ada@acme.example", workspaceId, workspaceName: "Acme", role: "owner" } as never;
  atTheScreen.member = { userId, name: "Ada", email: "ada@acme.example" } as never;
  return { services, calls };
}

async function owner() {
  const { workspaceId, userId } = await createTestWorkspace(db);
  return { workspaceId, userId, plain: await teammate(db, workspaceId) };
}

describe("the keys screen", () => {
  it("makes a key that opens the API, shown once, and ends it", async () => {
    const { workspaceId, userId } = await owner();
    sittingAs(workspaceId, userId);
    const { key } = await createKeyAction({}, form({ name: "Dashboard", scope: "figures:read" }));
    expect(atTheScreen.revalidated).toEqual(["/keys"]);
    expect(await accessOfKey(db, key as string, "figures:read")).toMatchObject({ status: "ok", workspaceId });
    const [{ id }] = await apiKeysOf(db, workspaceId);
    await revokeKeyAction(id);
    expect((await accessOfKey(db, key as string, "figures:read")).status).toBe("unknown");
  });

  it("refuses a plain member", async () => {
    const { workspaceId, plain } = await owner();
    sittingAs(workspaceId, plain);
    expect((await createKeyAction({}, form({ name: "Dashboard", scope: "figures:read" }))).error).toBeTruthy();
    expect(await apiKeysOf(db, workspaceId)).toEqual([]);
  });

  it("says when no scope was chosen", async () => {
    const { workspaceId, userId } = await owner();
    sittingAs(workspaceId, userId);
    expect((await createKeyAction({}, form({ name: "Dashboard" }))).error).toBe("Choose what this key may do.");
  });
});

describe("the indexing screen", () => {
  const sitemapUrl = "https://acme.example/sitemap.xml";
  async function onGoogle() {
    const seat = await owner();
    sittingAs(seat.workspaceId, seat.userId);
    await connectGoogle(testServices(db).services, seat.workspaceId, seat.userId);
    return { ...seat, site: await followSite(db, seat.workspaceId) };
  }

  it("submits a sitemap to the engine asked for, Google unless told otherwise", async () => {
    const { workspaceId, userId, site } = await onGoogle();
    const address = googleSitemapAddress("sc-domain:acme.example", sitemapUrl);
    const { calls } = sittingAs(workspaceId, userId, [GOOGLE_TOKEN, { match: `PUT ${address}`, json: {} }, { match: "GET https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aacme.example/sitemaps", json: {} }]);
    expect(await submitSitemapAction(site.id, null, form({ url: ` ${sitemapUrl} `, engine: "nonsense" }))).toEqual({ ok: true, said: "Submitted." });
    expect(calls.some(({ method, url }) => method === "PUT" && url === address)).toBe(true);
    expect(atTheScreen.revalidated).toEqual(["/indexing"]);
  });

  it("says what Google says about a page, in words", async () => {
    const { workspaceId, userId, site } = await onGoogle();
    sittingAs(workspaceId, userId, [GOOGLE_TOKEN, { match: INSPECT, json: inspected("PASS", "Submitted and indexed") }]);
    expect(await inspectAction(site.id, null, form({ url: "https://acme.example/a" }))).toEqual({ ok: true, said: "Indexed: Submitted and indexed." });
    sittingAs(workspaceId, userId, [GOOGLE_TOKEN, { match: INSPECT, json: inspected("NEUTRAL") }]);
    expect(await inspectAction(site.id, null, form({ url: "https://acme.example/a" }))).toEqual({ ok: true, said: "Not indexed." });
  });

  it("refuses a plain member, whose asking would spend the workspace's daily quota", async () => {
    const { workspaceId, plain, site } = await onGoogle();
    const { calls } = sittingAs(workspaceId, plain, [GOOGLE_TOKEN, { match: INSPECT, json: inspected("PASS") }]);
    expect(await inspectAction(site.id, null, form({ url: "https://acme.example/a" }))).toEqual({ ok: false, error: NOT_A_MANAGER_OF_SETTINGS });
    expect(calls).toEqual([]);
    expect((await submitSitemapAction(site.id, null, form({ url: sitemapUrl }))).ok).toBe(false);
  });
});

describe("the team screen", () => {
  it("invites, and cancels an invitation", async () => {
    const { workspaceId, userId } = await owner();
    sittingAs(workspaceId, userId);
    const invited = await inviteAction(null, form({ email: "bea@acme.example", role: "member" }));
    expect(invited).toMatchObject({ ok: true, email: "bea@acme.example" });
    expect(atTheScreen.revalidated).toEqual(["/settings"]);
    const [{ id }] = await openInvitationsOf(db, workspaceId);
    await cancelInvitationAction(id);
    expect(await openInvitationsOf(db, workspaceId)).toEqual([]);
  });

  it("changes a role, and refuses one that doesn't exist", async () => {
    const { workspaceId, userId, plain } = await owner();
    sittingAs(workspaceId, userId);
    expect(await changeRoleAction(plain, null, form({ role: "nonsense" }))).toEqual({ ok: false, error: "There’s no such role." });
    expect(await changeRoleAction(plain, null, form({ role: "admin" }))).toEqual({ ok: true, said: "Saved." });
    expect((await teamOf(db, workspaceId)).find(({ userId: id }) => id === plain)?.role).toBe("admin");
  });

  it("takes someone out", async () => {
    const { workspaceId, userId, plain } = await owner();
    sittingAs(workspaceId, userId);
    await removeMemberAction(plain);
    expect((await teamOf(db, workspaceId)).map(({ userId: id }) => id)).toEqual([userId]);
  });

  it("lets someone leave and sends them home, and keeps the last owner", async () => {
    const { workspaceId, userId, plain } = await owner();
    sittingAs(workspaceId, plain);
    expect(await whereItGoes(leaveWorkspaceAction())).toBe(HOME);
    expect(atTheScreen.forgotten).toBe(1);
    sittingAs(workspaceId, userId);
    expect(await whereItGoes(leaveWorkspaceAction())).toBe("/settings");
    expect(atTheScreen.forgotten).toBe(1);
  });
});

describe("the rank tracker", () => {
  it("follows a keyword and stops following it, for any member", async () => {
    const { workspaceId, plain } = await owner();
    sittingAs(workspaceId, plain);
    const site = await followSite(db, workspaceId);
    expect(await trackAction(null, form({ site: site.id, keyword: "acme pricing" }))).toMatchObject({ ok: true });
    expect(atTheScreen.revalidated).toEqual(["/rank-tracker", "/keywords"]);
    const [{ id }] = await trackedKeywordsOf(db, workspaceId, site.id, periodEndingAt(NOW, 7));
    expect(await untrackAction(site.id, id)).toMatchObject({ ok: true });
    expect(await trackedKeywordsOf(db, workspaceId, site.id, periodEndingAt(NOW, 7))).toEqual([]);
  });

  it("says when no keyword was given", async () => {
    const { workspaceId, plain } = await owner();
    sittingAs(workspaceId, plain);
    const site = await followSite(db, workspaceId);
    expect(await trackAction(null, form({ site: site.id, keyword: "  " }))).toEqual({ ok: false, error: "Say which keyword." });
  });

  it("reads back what was stored for a keyword already there", async () => {
    const { workspaceId, plain } = await owner();
    sittingAs(workspaceId, plain);
    const site = await followSite(db, workspaceId);
    await storeKeyword(db, workspaceId, site.id, "acme pricing", [{ day: "2026-11-01", clicks: 3, impressions: 30, position: 4 }]);
    await trackKeyword(db, workspaceId, site.id, "acme pricing");
    expect(await trackedKeywordsOf(db, workspaceId, site.id, periodEndingAt(NOW, 7))).toMatchObject([{ clicks: 3 }]);
  });
});

describe("the sites screen", () => {
  it("adds what an account can see, removes it, and makes and removes a group", async () => {
    const { workspaceId, userId } = await owner();
    sittingAs(workspaceId, userId);
    await connectBing(testServices(db).services, workspaceId, userId);
    sittingAs(workspaceId, userId, [BING_SITES]);
    expect(await addSitesAction(null, form({ domain: "acme.example" }))).toMatchObject({ ok: true });
    const [site] = await sitesOf(db, workspaceId);
    expect(atTheScreen.revalidated).toEqual(["/sites"]);
    expect(await saveGroupAction(null, form({ name: "Retail", site: [site.id] }))).toEqual({ ok: true, said: "Saved Retail, with 1 site." });
    const [{ id }] = await siteGroupsOf(db, workspaceId);
    expect(await removeGroupAction(id)).toMatchObject({ ok: true });
    expect(await removeSiteAction(site.id)).toMatchObject({ ok: true });
    expect(await sitesOf(db, workspaceId)).toEqual([]);
  });

  it("refuses a plain member", async () => {
    const { workspaceId, plain } = await owner();
    sittingAs(workspaceId, plain);
    const site = await followSite(db, workspaceId);
    for (const tried of [await addSitesAction(null, form({ domain: "acme.example" })), await removeSiteAction(site.id), await saveGroupAction(null, form({ name: "Mine", site: [site.id] })), await removeGroupAction(crypto.randomUUID())]) expect(tried).toEqual({ ok: false, error: NOT_A_MANAGER_OF_SETTINGS });
    expect(await sitesOf(db, workspaceId)).toHaveLength(1);
  });
});

describe("the connections screen", () => {
  it("connects from what was typed, checks and disconnects", async () => {
    const { workspaceId, userId } = await owner();
    sittingAs(workspaceId, userId, [BING_SITES]);
    expect(await connectAction("bing", {}, form({ apiKey: "a-bing-key" }))).toEqual({ connected: "Bing Webmaster Tools" });
    expect(atTheScreen.revalidated).toEqual(["/connections/bing"]);
    const [{ id }] = await connectionsOf(atTheScreen.services as never, workspaceId);
    expect(await checkAction("bing", id)).toMatchObject({ ok: true });
    await disconnectAction("bing", id);
    expect(await connectionsOf(atTheScreen.services as never, workspaceId)).toEqual([]);
  });

  it("says what the service said, keeping nothing", async () => {
    const { workspaceId, userId } = await owner();
    sittingAs(workspaceId, userId, [{ ...BING_SITES, status: 400, json: { ErrorCode: 3, Message: "ERROR!!! InvalidApiKey" } }]);
    expect((await connectAction("bing", {}, form({ apiKey: "a-bing-key" }))).error).toContain("Bing refused this key");
    expect(await connectionsOf(atTheScreen.services as never, workspaceId)).toEqual([]);
  });

  it("doesn't let a plain member check a connection, connect or disconnect", async () => {
    const { workspaceId, userId, plain } = await owner();
    const { id } = await connectBing(testServices(db).services, workspaceId, userId);
    const { calls } = sittingAs(workspaceId, plain, [BING_SITES, GOOGLE_SITES]);
    expect(await checkAction("bing", id)).toEqual({ ok: false, error: NOT_A_MANAGER_OF_SETTINGS });
    expect((await connectAction("bing", {}, form({ apiKey: "another" }))).error).toBe(NOT_A_MANAGER_OF_SETTINGS);
    await disconnectAction("bing", id);
    expect(calls).toEqual([]);
    expect(await connectionsOf(testServices(db).services, workspaceId)).toHaveLength(1);
  });
});

describe("an invitation's link", () => {
  async function invited(email: string) {
    const { workspaceId, userId } = await owner();
    const made = await inviteToWorkspace(testServices(db).services, workspaceId, userId, email, "member");
    if (!made.ok || !made.link) throw new Error("Not invited");
    return { workspaceId, token: new URL(made.link).pathname.split("/").at(-1) as string };
  }

  it("sends someone signed out to sign in first, and back", async () => {
    const { token } = await invited("bea@acme.example");
    atTheScreen.member = null;
    expect(await whereItGoes(joinAction(token))).toBe(`/sign-in?${new URLSearchParams({ next: invitationPath(token) })}`);
  });

  it("lets the right person in, and enters the workspace", async () => {
    const { workspaceId, token } = await invited("bea@acme.example");
    const userId = await teammate(db, (await createTestWorkspace(db)).workspaceId);
    const { user } = await import("@/infrastructure/db/schema/auth");
    const { eq } = await import("drizzle-orm");
    await db.update(user).set({ email: "bea@acme.example", emailVerified: true }).where(eq(user.id, userId));
    atTheScreen.services = testServices(db).services;
    atTheScreen.member = { userId, name: "Bea", email: "bea@acme.example" } as never;
    expect(await whereItGoes(joinAction(token))).toBe(HOME);
    expect(atTheScreen.entered).toEqual([workspaceId]);
  });

  it("goes back to the link's page, which says why, when refused", async () => {
    const { token } = await invited("bea@acme.example");
    const { userId } = await createTestWorkspace(db);
    atTheScreen.services = testServices(db).services;
    atTheScreen.member = { userId, name: "Eve", email: "eve@acme.example" } as never;
    expect(await whereItGoes(joinAction(token))).toBe(invitationPath(token));
    expect(atTheScreen.entered).toEqual([]);
  });
});
