import { renderToReadableStream } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inviteToWorkspace } from "@/application/invitations";
import { saveSiteGroup } from "@/application/site-groups";
import { trackKeyword } from "@/application/rank-tracker";
import type { Database } from "@/infrastructure/db/client";
import { indexCheck, sitemap, site as siteTable } from "@/infrastructure/db/schema/search";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Env } from "@/infrastructure/env";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { atTheScreen, Redirected, whereItGoes } from "./support/at-the-screen";
import { BING_SITES, connectBing, connectGoogle, followSite, GOOGLE_SITES, GOOGLE_TOKEN, NOW, storeKeyword, storePage, storeTotals, teammate, testServices, testSettings } from "./support/search";

const settings = vi.hoisted(() => ({ now: {} as Record<string, unknown> }));
const client = vi.hoisted(() => ({ asking: null as Record<string, string> | null }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), connection: async () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/font/google", () => ({ Geologica: () => ({ variable: "sans" }), Spline_Sans_Mono: () => ({ variable: "mono" }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
  notFound: () => {
    throw new Redirected("not found");
  },
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/infrastructure/auth/session", () => ({
  currentSeat: async () => atTheScreen.seat,
  currentMember: async () => atTheScreen.member,
  enterWorkspace: async () => {},
  forgetWorkspace: async () => {},
  workspacesInBrowser: async () => ({ workspaces: [{ id: atTheScreen.seat?.workspaceId, name: "Acme" }, { id: crypto.randomUUID(), name: "Northwind" }], active: { id: atTheScreen.seat?.workspaceId, name: "Acme" } }),
}));
vi.mock("@/infrastructure/auth/server", () => ({ auth: () => ({ api: { getOAuthClientPublic: async () => client.asking } }), mcpResource: () => "https://owlseen.test/api/mcp" }));
vi.mock("@/infrastructure/services", () => ({ appServices: () => atTheScreen.services }));
vi.mock("@/infrastructure/db/client", async (original) => ({ ...(await original<typeof import("@/infrastructure/db/client")>()), db: () => atTheScreen.db }));
vi.mock("@/infrastructure/env", async (original) => ({ ...(await original<typeof import("@/infrastructure/env")>()), env: () => settings.now as unknown as Env }));

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
  atTheScreen.db = db;
});
beforeEach(() => {
  settings.now = { ...testSettings, OWLSEEN_ADMINS: "ada@acme.example", OWLSEEN_PASSWORD_SIGN_IN: true };
  client.asking = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/** The whole page, as text a person reads: every part that streams in has arrived. */
async function textOf(page: ReactNode): Promise<string> {
  const failures: unknown[] = [];
  const stream = await renderToReadableStream(page, { onError: (error) => void failures.push(error) });
  await stream.allReady;
  // React separates text from what's put into it with an empty comment.
  const html = (await new Response(stream).text()).replaceAll("<!-- -->", "");
  const redirected = failures.find((failure) => failure instanceof Redirected);
  if (redirected) throw redirected;
  if (failures.length > 0) throw failures[0];
  return html;
}

const query = (asked: Record<string, string> = {}) => Promise.resolve(asked);

function sittingAs(workspaceId: string, userId: string, role: "owner" | "admin" | "member" = "owner", routes: Parameters<typeof testServices>[1] = []) {
  atTheScreen.services = testServices(db, routes).services;
  atTheScreen.seat = { userId, name: "Ada", email: "ada@acme.example", workspaceId, workspaceName: "Acme", role } as never;
  atTheScreen.member = { userId, name: "Ada", email: "ada@acme.example" } as never;
}

async function empty() {
  const { workspaceId, userId } = await createTestWorkspace(db);
  sittingAs(workspaceId, userId);
  return { workspaceId, userId };
}

/** A workspace with a bit of everything, the way a read leaves it. */
async function stocked() {
  const { workspaceId, userId } = await empty();
  const site = await followSite(db, workspaceId, "acme.example", { bingSite: "https://www.acme.example/" });
  const quiet = await followSite(db, workspaceId, "northwind.example");
  await withWorkspace(db, workspaceId, (tx) => tx.update(siteTable).set({ lastSyncedAt: NOW }));
  await withWorkspace(db, workspaceId, (tx) => tx.update(siteTable).set({ lastSyncError: "Google refused access." }).where(eqSite(quiet.id)));
  const today = new Date();
  const dayBack = (back: number) => new Date(today.getTime() - back * 86_400_000).toISOString().slice(0, 10);
  const days = Array.from({ length: 20 }, (_, back) => ({ day: dayBack(back + 1), clicks: back < 7 ? 5 : 60, impressions: 500, position: 6 }));
  await storeTotals(db, workspaceId, site.id, "google", days);
  await storeTotals(db, workspaceId, site.id, "bing", days.map((day) => ({ ...day, position: null })));
  const keywordDays = Array.from({ length: 20 }, (_, back) => ({ day: dayBack(back + 1), clicks: back < 7 ? 1 : 30, impressions: 300, position: 12 }));
  await storeKeyword(db, workspaceId, site.id, "acme pricing", keywordDays);
  await trackKeyword(db, workspaceId, site.id, "acme pricing");
  const pageId = await storePage(db, workspaceId, site.id, "https://acme.example/pricing", keywordDays);
  await withWorkspace(db, workspaceId, async (tx) => {
    await tx.insert(indexCheck).values([{ siteId: site.id, pageId, day: dayBack(30), verdict: "PASS" }, { siteId: site.id, pageId, day: dayBack(2), verdict: "NEUTRAL", coverage: "Crawled - currently not indexed" }]);
    await tx.insert(sitemap).values({ siteId: site.id, engine: "google", url: "https://acme.example/sitemap.xml", urls: 12 });
  });
  await saveSiteGroup(db, workspaceId, userId, "Retail", [site.id]);
  return { workspaceId, userId, site };
}

const eqSite = (id: string) => sqlEq(siteTable.id, id);
const { eq: sqlEq } = await import("drizzle-orm");

const screen = async (path: string) => (await import(`@/app/${path}/page.tsx`)).default;

describe("a workspace with no site yet", () => {
  it.each(["overview", "keywords", "pages", "rank-tracker", "indexing"])("says what to do on %s", async (path) => {
    await empty();
    const Page = await screen(path);
    expect(await textOf(<Page searchParams={query()} />)).toContain("No sites yet");
  });

  it("says so on the sites screen, and offers what's connected", async () => {
    const { workspaceId, userId } = await empty();
    await connectBing(testServices(db).services, workspaceId, userId);
    sittingAs(workspaceId, userId, "owner", [BING_SITES]);
    const Page = await screen("sites");
    const page = await textOf(<Page searchParams={query()} />);
    expect(page).toContain("No sites yet");
    expect(page).toContain("Add these sites");
    expect(page).toContain("acme.example");
  });

  it("says when nothing is connected to offer a site from", async () => {
    await empty();
    const Page = await screen("sites");
    expect(await textOf(<Page searchParams={query()} />)).toContain("Connect an account first");
  });

  it("says what the engine said when it can't list sites", async () => {
    const { workspaceId, userId } = await empty();
    await connectBing(testServices(db).services, workspaceId, userId);
    sittingAs(workspaceId, userId, "owner", [{ ...BING_SITES, status: 400, json: { ErrorCode: 3, Message: "ERROR!!! InvalidApiKey" } }]);
    const Page = await screen("sites");
    expect(await textOf(<Page searchParams={query()} />)).toContain("Bing refused this key");
  });
});

describe("reading a workspace", () => {
  it("shows the overview: figures, engines side by side, what moved and what left the index", async () => {
    await stocked();
    const Page = await screen("overview");
    const page = await textOf(<Page searchParams={query()} />);
    for (const words of ["Clicks", "Impressions", "Click-through", "Average position", "Google", "Bing", "What moved this week", "Falling hard", "Left the index", "acme.example"]) expect(page).toContain(words);
  });

  it("says how far each engine has reported, draws what hasn't been as hollow, and which days the totals cover", async () => {
    await stocked();
    const Page = await screen("overview");
    const page = await textOf(<Page searchParams={query({ days: "7" })} />);
    expect(page).toContain("Google has reported up to");
    expect(page).toContain("Bing has reported up to");
    expect(page).toContain("the days reported so far,");
    expect(page).toContain("not reported yet");
    expect(page).toContain("data-not-reported");
  });

  it.each(["sites", "keywords", "pages", "rank-tracker"])("says how far each engine has reported on %s", async (path) => {
    await stocked();
    const Page = await screen(path);
    expect(await textOf(<Page searchParams={query()} />)).toContain("Google has reported up to");
  });

  it("draws a card's unreported days as hollow too", async () => {
    await stocked();
    const Page = await screen("sites");
    expect(await textOf(<Page searchParams={query({ days: "7" })} />)).toContain("data-not-reported");
  });

  it("says a site has gone quiet, when it has", async () => {
    const { workspaceId, userId } = await empty();
    const site = await followSite(db, workspaceId);
    await withWorkspace(db, workspaceId, (tx) => tx.update(siteTable).set({ googleReadAt: new Date(), lastSyncedAt: new Date() }));
    const dayBack = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
    await storeTotals(db, workspaceId, site.id, "google", Array.from({ length: 14 }, (_, back) => ({ day: dayBack(back + 8), clicks: 100, impressions: 1000, position: 5 })));
    sittingAs(workspaceId, userId);
    const Page = await screen("overview");
    const page = await textOf(<Page searchParams={query({ days: "7" })} />);
    expect(page).toContain("Gone quiet");
    expect(page).toContain("nothing since");
  });

  it("says when nothing has been reported yet", async () => {
    const { workspaceId, userId } = await empty();
    await followSite(db, workspaceId);
    sittingAs(workspaceId, userId);
    const Page = await screen("overview");
    const page = await textOf(<Page searchParams={query()} />);
    expect(page).toContain("No engine has reported anything here yet");
    expect(page).toContain("Nothing has been reported yet");
  });

  it("says a connection isn't being read, rather than anything about its sites", async () => {
    const { workspaceId } = await stocked();
    const { userId } = atTheScreen.seat as unknown as { userId: string };
    const { id } = await connectBing(testServices(db).services, workspaceId, userId);
    const { markFailing } = await import("@/application/connections");
    await markFailing(testServices(db).services, workspaceId, id, "Bing refused this key.");
    const Page = await screen("overview");
    const page = await textOf(<Page searchParams={query()} />);
    expect(page).toContain("Not being read");
    expect(page).toContain("Bing refused this key.");
  });

  it("agrees with the alert when everything a workspace has stopped some time ago", async () => {
    const { workspaceId, userId } = await empty();
    const site = await followSite(db, workspaceId);
    await withWorkspace(db, workspaceId, (tx) => tx.update(siteTable).set({ googleReadAt: new Date(), lastSyncedAt: new Date() }));
    const dayBack = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
    await storeTotals(db, workspaceId, site.id, "google", Array.from({ length: 14 }, (_, back) => ({ day: dayBack(back + 8), clicks: 100, impressions: 1000, position: 5 })));
    sittingAs(workspaceId, userId);
    const Page = await screen("overview");
    const page = await textOf(<Page searchParams={query({ days: "7" })} />);
    expect(page).toContain("Gone quiet");
    expect(page).toContain("The engines list nothing here since");
    expect(page).not.toContain("Nothing has been reported");
  });

  it("reads one site or one group when asked", async () => {
    const { site, workspaceId } = await stocked();
    const Page = await screen("overview");
    expect(await textOf(<Page searchParams={query({ site: site.id, days: "7" })} />)).toContain("Clicks");
    const { siteGroupsOf } = await import("@/application/site-groups");
    const [group] = await siteGroupsOf(db, workspaceId);
    expect(await textOf(<Page searchParams={query({ site: `group:${group.id}` })} />)).toContain("Retail");
  });

  it("shows the sites as cards, with links through, the error of one that failed, and groups", async () => {
    const { site } = await stocked();
    const Page = await screen("sites");
    const page = await textOf(<Page searchParams={query()} />);
    for (const words of [`/keywords?site=${site.id}`, `/pages?site=${site.id}`, `/indexing?site=${site.id}`, "Google refused access.", "Retail", "Make a group", "Add sites"]) expect(page).toContain(words);
  });

  it("offers a plain member nothing to change on the sites screen", async () => {
    const { workspaceId } = await stocked();
    sittingAs(workspaceId, await teammate(db, workspaceId), "member");
    const Page = await screen("sites");
    const page = await textOf(<Page searchParams={query()} />);
    expect(page).toContain("acme.example");
    expect(page).not.toContain("Add sites");
    expect(page).not.toContain("Make a group");
  });

  it.each([
    [{}, "acme pricing"],
    [{ view: "opportunities" }, "acme pricing"],
    [{ view: "moved" }, "acme pricing"],
    [{ view: "moved", q: "nothing like this" }, "Nothing here for this period"],
  ])("shows keywords, as asked by %j", async (asked, words) => {
    await stocked();
    const Page = await screen("keywords");
    expect(await textOf(<Page searchParams={query(asked as Record<string, string>)} />)).toContain(words);
  });

  it("shows pages, and those losing their traffic", async () => {
    await stocked();
    const Page = await screen("pages");
    expect(await textOf(<Page searchParams={query()} />)).toContain("https://acme.example/pricing");
  });

  it("shows keywords followed, and says how many when there are too many to show", async () => {
    const { workspaceId, site } = await stocked();
    const Page = await screen("rank-tracker");
    expect(await textOf(<Page searchParams={query()} />)).toContain("acme pricing");
    for (let index = 0; index < 100; index += 1) await trackKeyword(db, workspaceId, site.id, `word ${index}`);
    expect(await textOf(<Page searchParams={query({ site: site.id })} />)).toContain("The 100 most clicked of the 101 followed");
  });

  it("says when no keyword is followed", async () => {
    const { workspaceId, userId } = await empty();
    await followSite(db, workspaceId);
    sittingAs(workspaceId, userId);
    const Page = await screen("rank-tracker");
    expect(await textOf(<Page searchParams={query()} />)).toContain("No keyword followed yet");
  });

  it("shows indexing: what dropped and since when, sitemaps, and forms for one site to whoever manages it", async () => {
    const { workspaceId, site } = await stocked();
    const Page = await screen("indexing");
    const all = await textOf(<Page searchParams={query()} />);
    for (const words of ["Crawled - currently not indexed", "https://acme.example/sitemap.xml"]) expect(all).toContain(words);
    const one = await textOf(<Page searchParams={query({ site: site.id })} />);
    sittingAs(workspaceId, await teammate(db, workspaceId), "member");
    const plain = await textOf(<Page searchParams={query({ site: site.id })} />);
    expect(one.length).toBeGreaterThan(plain.length);
  });
});

describe("settings", () => {
  it("lists connectors, then a connector's page", async () => {
    const { workspaceId, userId } = await empty();
    const List = await screen("connections");
    expect(await textOf(<List />)).toContain("Google Search Console");
    await connectBing(testServices(db).services, workspaceId, userId);
    const Kind = (await import("@/app/connections/[kind]/page")).default;
    const bing = await textOf(<Kind params={Promise.resolve({ kind: "bing" })} searchParams={query({ said: "All good." })} />);
    for (const words of ["Bing Webmaster Tools", "All good.", "Connect again, with a new key"]) expect(bing).toContain(words);
    const google = await textOf(<Kind params={Promise.resolve({ kind: "google" })} searchParams={query({ error: "No." })} />);
    for (const words of ["/api/connections/google/callback", "No."]) expect(google).toContain(words);
  });

  it("offers to allow access for a client that's been saved, and names an account that has", async () => {
    const { workspaceId, userId } = await empty();
    await connectGoogle(testServices(db, [GOOGLE_TOKEN, GOOGLE_SITES, { match: "GET https://openidconnect.googleapis.com/v1/userinfo", json: { email: "ada@acme.example" } }]).services, workspaceId, userId);
    const Kind = (await import("@/app/connections/[kind]/page")).default;
    expect(await textOf(<Kind params={Promise.resolve({ kind: "google" })} searchParams={query()} />)).toContain("ada@acme.example");
  });

  it("knows no such connector", async () => {
    await empty();
    const Kind = (await import("@/app/connections/[kind]/page")).default;
    await expect(textOf(<Kind params={Promise.resolve({ kind: "nonsense" })} searchParams={query()} />)).rejects.toMatchObject({ to: "not found" });
  });

  it("tells a plain member that only managers change a connection", async () => {
    const { workspaceId } = await empty();
    sittingAs(workspaceId, await teammate(db, workspaceId), "member");
    const Kind = (await import("@/app/connections/[kind]/page")).default;
    expect(await textOf(<Kind params={Promise.resolve({ kind: "bing" })} searchParams={query()} />)).toContain("Only owners and");
  });

  it("shows keys and how to use them", async () => {
    const { workspaceId, userId } = await empty();
    const { createApiKey } = await import("@/application/api-keys");
    await createApiKey(db, workspaceId, userId, "Dashboard", ["figures:read"]);
    const Page = await screen("keys");
    const page = await textOf(<Page />);
    for (const words of ["Dashboard", "/api/v1/figures", "Create a key"]) expect(page).toContain(words);
  });

  it("shows the team, invitations, and how to connect an assistant", async () => {
    const { workspaceId, userId } = await empty();
    await teammate(db, workspaceId);
    await inviteToWorkspace(testServices(db).services, workspaceId, userId, "bea@acme.example", "member");
    const Page = await screen("settings");
    const page = await textOf(<Page />);
    for (const words of ["Team", "bea@acme.example", "https://owlseen.test/api/mcp"]) expect(page).toContain(words);
  });

  it("gives a plain member no way to run the team", async () => {
    const { workspaceId } = await empty();
    sittingAs(workspaceId, await teammate(db, workspaceId), "member");
    const Page = await screen("settings");
    const page = await textOf(<Page />);
    expect(page).toContain("Team");
    expect(page).not.toContain("Address to invite");
  });
});

describe("before a workspace", () => {
  it("offers the ways in this instance has", async () => {
    const Page = await screen("sign-in");
    const page = await textOf(<Page searchParams={query()} />);
    expect(page).toContain("Every site you run");
    expect(page).toContain("Create an account");
    settings.now = { ...settings.now, OWLSEEN_PASSWORD_SIGN_IN: false, GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b" };
    expect(await textOf(<Page searchParams={query({ next: "/join/abc" })} />)).toContain("Sign in with the invited address");
    settings.now = { ...settings.now, GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined };
    expect(await textOf(<Page searchParams={query({ error: "signup_disabled" })} />)).toContain("isn’t open on this instance");
  });

  it("offers a new password only where passwords exist", async () => {
    const Page = await screen("reset-password");
    expect(await textOf(<Page searchParams={query({ token: "a-token" })} />)).toBeTruthy();
    settings.now = { ...settings.now, OWLSEEN_PASSWORD_SIGN_IN: false };
    await expect(textOf(<Page searchParams={query({ token: "a-token" })} />)).rejects.toMatchObject({ to: "not found" });
  });

  it("asks who may start a workspace to name it, and tells the others it's by invitation", async () => {
    await empty();
    const Page = await screen("welcome");
    expect(await textOf(<Page searchParams={query()} />)).toContain("Which company is this for?");
    atTheScreen.member = { userId: crypto.randomUUID(), email: "stranger@example.com", name: "S" } as never;
    expect(await textOf(<Page searchParams={query()} />)).toContain("You don’t have access to any workspace");
  });

  it("sends someone signed out to sign in", async () => {
    atTheScreen.member = null;
    const Page = await screen("welcome");
    await expect(textOf(<Page searchParams={query()} />)).rejects.toMatchObject({ to: "/sign-in" });
  });

  it("shows an invitation's link for the right person, and says why not for the wrong one", async () => {
    const { workspaceId, userId } = await empty();
    const made = await inviteToWorkspace(testServices(db).services, workspaceId, userId, "bea@acme.example", "member");
    if (!made.ok || !made.link) throw new Error("Not invited");
    const token = new URL(made.link).pathname.split("/").at(-1) as string;
    const Page = (await import("@/app/join/[token]/page")).default;
    expect(await textOf(<Page params={Promise.resolve({ token })} searchParams={query()} />)).toContain("invitation");
    atTheScreen.member = null;
    await expect(textOf(<Page params={Promise.resolve({ token })} searchParams={query()} />)).rejects.toBeInstanceOf(Redirected);
  });

  it("shows what approving an assistant does, and where it sends you", async () => {
    await empty();
    client.asking = { client_name: "Claude", client_uri: "https://claude.ai" };
    const Page = await screen("consent");
    const page = await textOf(<Page searchParams={query({ client_id: "a-client", redirect_uri: "https://evil.example/callback" })} />);
    for (const words of ["An app calling itself “Claude”", "evil.example", "make and revoke API keys", "Allow"]) expect(page).toContain(words);
  });

  it("names a new member's workspace first, then comes back to approving", async () => {
    const { userId } = await createTestWorkspace(db);
    atTheScreen.member = { userId: `${userId}-new`, email: "ada@acme.example", name: "Ada" } as never;
    const Page = await screen("consent");
    await expect(textOf(<Page searchParams={query({ client_id: "a-client" })} />)).rejects.toMatchObject({ to: expect.stringContaining("/welcome?next=") });
    atTheScreen.member = null;
    await expect(whereItGoes(textOf(<Page searchParams={query()} />))).resolves.toBe("/sign-in");
  });

  it("frames every page, dark first", async () => {
    const { default: Layout } = await import("@/app/layout");
    const page = await textOf(<Layout params={Promise.resolve({})}><p>Hello</p></Layout>);
    expect(page).toContain("Hello");
    expect(page).toContain("dark");
  });
});
