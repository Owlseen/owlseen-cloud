import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { indexingOf, inspectPage, runIndexChecks, submitSitemap } from "@/application/indexing";
import { NOT_A_MANAGER_OF_SETTINGS } from "@/domain/team";
import { inspectionOf } from "@/infrastructure/connectors/google";
import type { Database } from "@/infrastructure/db/client";
import { indexCheck, page, site, sitemap } from "@/infrastructure/db/schema/search";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import type { FakeRoute, RecordedCall } from "./support/fetch";
import { bingFigures, connectBing, connectGoogle, followSite, GOOGLE_TOKEN, googleProperty, googleSitemapAddress, INSPECT, inspected, NOW, servicesRunningOutOfTime, storePage, teammate, testServices } from "./support/search";

const PASSING: FakeRoute = { match: INSPECT, json: inspected("PASS", "Submitted and indexed", "2026-11-01T06:00:00Z") };
const FAR_AWAY = NOW.getTime() + 3_600_000;
const ACME_PAGE = "https://acme.example/pricing";

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
});
// The job reads every workspace, so each test starts with no site.
beforeEach(async () => {
  await db.delete(site);
});

/** A workspace with Google connected, following one site. */
async function followedOnGoogle(name = "acme.example") {
  const seat = await createTestWorkspace(db);
  await connectGoogle(testServices(db).services, seat.workspaceId, seat.userId);
  return { ...seat, site: await followSite(db, seat.workspaceId, name) };
}

const pageAsked = ({ body }: RecordedCall) => (JSON.parse(body) as { inspectionUrl: string }).inspectionUrl;
const inspections = (calls: RecordedCall[]) => calls.filter(({ url }) => url.includes("urlInspection")).map(pageAsked);
const checksIn = (workspaceId: string) => withWorkspace(db, workspaceId, (tx) => tx.select().from(indexCheck));
const pagesIn = (workspaceId: string) => withWorkspace(db, workspaceId, (tx) => tx.select().from(page).orderBy(page.url));

const askedAt = (workspaceId: string, id: number, moment: string) => withWorkspace(db, workspaceId, (tx) => tx.update(page).set({ inspectedAt: new Date(moment) }).where(eq(page.id, id)));

async function storeChecks(workspaceId: string, siteId: string, url: string, checks: { day: string; verdict: string; coverage?: string }[]) {
  const pageId = await storePage(db, workspaceId, siteId, url);
  await withWorkspace(db, workspaceId, (tx) => tx.insert(indexCheck).values(checks.map((check) => ({ siteId, pageId, ...check }))));
  return pageId;
}

describe("which pages a run asks about", () => {
  it("is those never asked first, then those asked longest ago", async () => {
    const { workspaceId, site: { id } } = await followedOnGoogle();
    const older = await storePage(db, workspaceId, id, "https://acme.example/older");
    const recent = await storePage(db, workspaceId, id, "https://acme.example/recent");
    await storePage(db, workspaceId, id, "https://acme.example/never");
    await askedAt(workspaceId, older, "2026-09-01T00:00:00Z");
    await askedAt(workspaceId, recent, "2026-10-01T00:00:00Z");
    const { services, calls } = testServices(db, [GOOGLE_TOKEN, PASSING]);
    await runIndexChecks(services, FAR_AWAY);
    expect(inspections(calls)).toEqual(["https://acme.example/never", "https://acme.example/older", "https://acme.example/recent"]);
  });

  it("is at most 100 a site, the next run taking the rest", async () => {
    const { workspaceId, site: { id } } = await followedOnGoogle();
    const other = await followSite(db, workspaceId, "northwind.example");
    await withWorkspace(db, workspaceId, (tx) => tx.insert(page).values(Array.from({ length: 101 }, (_, index) => ({ siteId: id, url: `https://acme.example/${index}` }))));
    await storePage(db, workspaceId, other.id, "https://northwind.example/only");
    const { services, calls } = testServices(db, [GOOGLE_TOKEN, PASSING]);
    expect(await runIndexChecks(services, FAR_AWAY)).toEqual({ checked: 101, failed: 0, left: 0 });
    expect(inspections(calls).filter((url) => url.includes("acme"))).toHaveLength(100);
    expect(inspections(calls)).toContain("https://northwind.example/only");
    expect(await runIndexChecks(services, FAR_AWAY)).toEqual({ checked: 1, failed: 0, left: 0 });
    expect(await runIndexChecks(services, FAR_AWAY)).toEqual({ checked: 0, failed: 0, left: 0 });
  });

  it("leaves a page asked in the last week, and asks again after it", async () => {
    const { workspaceId, site: { id } } = await followedOnGoogle();
    const within = await storePage(db, workspaceId, id, "https://acme.example/within");
    const lastDay = await storePage(db, workspaceId, id, "https://acme.example/last-day");
    const past = await storePage(db, workspaceId, id, "https://acme.example/past");
    // On 5 November, the week counts back to the start of 29 October.
    await askedAt(workspaceId, within, "2026-11-04T09:00:00Z");
    await askedAt(workspaceId, lastDay, "2026-10-29T00:00:00Z");
    await askedAt(workspaceId, past, "2026-10-28T23:59:59Z");
    const { services, calls } = testServices(db, [GOOGLE_TOKEN, PASSING]);
    expect(await runIndexChecks(services, FAR_AWAY)).toEqual({ checked: 1, failed: 0, left: 0 });
    expect(inspections(calls)).toEqual(["https://acme.example/past"]);
  });

  it("skips a site not on Google, and asks nobody without a Google connection", async () => {
    const seat = await createTestWorkspace(db);
    await connectBing(testServices(db).services, seat.workspaceId, seat.userId);
    const onBing = await followSite(db, seat.workspaceId, "northwind.example", { googleProperty: null, bingSite: "https://northwind.example/" });
    const unasked = await followSite(db, seat.workspaceId, "acme.example");
    await storePage(db, seat.workspaceId, onBing.id, "https://northwind.example/a");
    await storePage(db, seat.workspaceId, unasked.id, ACME_PAGE);
    const { services, calls } = testServices(db, [GOOGLE_TOKEN, PASSING]);
    expect(await runIndexChecks(services, FAR_AWAY)).toEqual({ checked: 0, failed: 0, left: 0 });
    expect(calls).toEqual([]);
  });
});

describe("what a check leaves", () => {
  it("is the verdict, Google's words and the last crawl, and when it was asked", async () => {
    const { workspaceId, site: { id } } = await followedOnGoogle();
    const pageId = await storePage(db, workspaceId, id, ACME_PAGE);
    const { services, calls } = testServices(db, [GOOGLE_TOKEN, PASSING]);
    expect(await runIndexChecks(services, FAR_AWAY)).toEqual({ checked: 1, failed: 0, left: 0 });
    expect(await checksIn(workspaceId)).toEqual([{ workspaceId, siteId: id, pageId, day: "2026-11-05", verdict: "PASS", coverage: "Submitted and indexed", lastCrawlAt: new Date("2026-11-01T06:00:00Z") }]);
    expect((await pagesIn(workspaceId))[0].inspectedAt).toEqual(NOW);
    expect(JSON.parse(calls.find(({ url }) => url.includes("urlInspection"))?.body as string)).toEqual({ siteUrl: "sc-domain:acme.example", inspectionUrl: ACME_PAGE, languageCode: "en-US" });
  });

  it("replaces a check made earlier the same day", async () => {
    const { workspaceId, site: { id } } = await followedOnGoogle();
    const pageId = await storeChecks(workspaceId, id, ACME_PAGE, [{ day: "2026-11-05", verdict: "NEUTRAL", coverage: "Crawled" }]);
    const { services } = testServices(db, [GOOGLE_TOKEN, PASSING]);
    await runIndexChecks(services, FAR_AWAY);
    expect(await checksIn(workspaceId)).toMatchObject([{ pageId, verdict: "PASS", coverage: "Submitted and indexed" }]);
  });

  it("reads what Google gives, missing or odd parts included", () => {
    expect(inspectionOf({})).toEqual({ verdict: "VERDICT_UNSPECIFIED", coverage: null, lastCrawlAt: null });
    expect(inspectionOf(inspected("FAIL", "Blocked", "not a date"))).toEqual({ verdict: "FAIL", coverage: "Blocked", lastCrawlAt: null });
  });
});

describe("a failure", () => {
  const FAILING_ONE: FakeRoute = { match: INSPECT, bodyHas: "/broken", status: 404, json: { message: "No such page" } };

  it("doesn't stop the rest, and a page the engine won't answer about goes to the back of the queue", async () => {
    const { workspaceId, site: { id } } = await followedOnGoogle();
    await storePage(db, workspaceId, id, "https://acme.example/broken");
    await storePage(db, workspaceId, id, "https://acme.example/fine");
    const { services } = testServices(db, [GOOGLE_TOKEN, FAILING_ONE, PASSING]);
    expect(await runIndexChecks(services, FAR_AWAY)).toEqual({ checked: 1, failed: 1, left: 0 });
    expect((await pagesIn(workspaceId)).map(({ url, inspectedAt }) => [url, inspectedAt])).toEqual([["https://acme.example/broken", NOW], ["https://acme.example/fine", NOW]]);
    expect(await checksIn(workspaceId)).toHaveLength(1);
    expect(await runIndexChecks(testServices(db, [GOOGLE_TOKEN, PASSING]).services, FAR_AWAY)).toEqual({ checked: 0, failed: 0, left: 0 });
  });

  it("leaves a page due when the engine itself is failing", async () => {
    const { workspaceId, site: { id } } = await followedOnGoogle();
    await storePage(db, workspaceId, id, "https://acme.example/fine");
    const { services } = testServices(db, [GOOGLE_TOKEN, { match: INSPECT, status: 500, json: { error: { message: "Backend error" } } }]);
    expect(await runIndexChecks(services, FAR_AWAY)).toEqual({ checked: 0, failed: 1, left: 0 });
    expect((await pagesIn(workspaceId))[0].inspectedAt).toBeNull();
    expect(await runIndexChecks(testServices(db, [GOOGLE_TOKEN, PASSING]).services, FAR_AWAY)).toEqual({ checked: 1, failed: 0, left: 0 });
  });
});

describe("a deadline", () => {
  it("reports what's left, asked next time", async () => {
    const { workspaceId, site: { id } } = await followedOnGoogle();
    for (const name of ["a", "b", "c", "d", "e", "f"]) await storePage(db, workspaceId, id, `https://acme.example/${name}`);
    const deadline = NOW.getTime() + 60_000;
    const { services } = servicesRunningOutOfTime(db, [GOOGLE_TOKEN, PASSING], deadline);
    // Four at once were already on their way when the time ran out.
    expect(await runIndexChecks(services, deadline)).toEqual({ checked: 4, failed: 0, left: 2 });
    expect(await runIndexChecks(testServices(db, [GOOGLE_TOKEN, PASSING]).services, FAR_AWAY)).toEqual({ checked: 2, failed: 0, left: 0 });
  });

  it("already past asks nothing", async () => {
    const { workspaceId, site: { id } } = await followedOnGoogle();
    await storePage(db, workspaceId, id, ACME_PAGE);
    const { services, calls } = testServices(db, [GOOGLE_TOKEN, PASSING]);
    expect(await runIndexChecks(services, NOW.getTime())).toEqual({ checked: 0, failed: 0, left: 1 });
    expect(calls).toEqual([]);
  });
});

describe("what's indexed", () => {
  it("counts each page once, from all its checks, and lists those that dropped", async () => {
    const { workspaceId, site: { id, name } } = await followedOnGoogle();
    await storeChecks(workspaceId, id, "https://acme.example/in", [{ day: "2026-10-01", verdict: "PASS" }, { day: "2026-10-08", verdict: "PASS" }]);
    await storeChecks(workspaceId, id, "https://acme.example/back", [{ day: "2026-10-01", verdict: "FAIL" }, { day: "2026-10-08", verdict: "PASS" }]);
    await storeChecks(workspaceId, id, "https://acme.example/never", [{ day: "2026-10-01", verdict: "NEUTRAL", coverage: "Discovered" }]);
    await storeChecks(workspaceId, id, "https://acme.example/out", [{ day: "2026-10-01", verdict: "PASS" }, { day: "2026-10-08", verdict: "NEUTRAL", coverage: "Crawled" }, { day: "2026-10-15", verdict: "NEUTRAL", coverage: "Blocked" }]);
    expect(await indexingOf(db, workspaceId, id, NOW)).toEqual([{ siteId: id, siteName: name, checked: 4, indexed: 2, notIndexed: 2, dropped: [{ url: "https://acme.example/out", since: "2026-10-08", coverage: "Blocked" }], sitemaps: [] }]);
  });

  it("puts those that dropped last first, and shows 50 at most", async () => {
    const { workspaceId, site: { id } } = await followedOnGoogle();
    const dropped = (url: string, on: string) => storeChecks(workspaceId, id, url, [{ day: "2026-08-01", verdict: "PASS" }, { day: on, verdict: "FAIL" }]);
    await dropped("https://acme.example/early", "2026-09-01");
    await dropped("https://acme.example/late", "2026-10-01");
    for (let index = 0; index < 50; index += 1) await dropped(`https://acme.example/more-${index}`, "2026-09-15");
    const [indexing] = await indexingOf(db, workspaceId, id, NOW);
    expect(indexing.notIndexed).toBe(52);
    expect(indexing.dropped).toHaveLength(50);
    expect(indexing.dropped[0].url).toBe("https://acme.example/late");
    expect(indexing.dropped.map(({ url }) => url)).not.toContain("https://acme.example/early");
  });

  it("only looks back 180 days: a page last seen indexed before that hasn't dropped, as far as this can say", async () => {
    const { workspaceId, site: { id } } = await followedOnGoogle();
    // On 5 November 2026, 180 days back is 9 May.
    await storeChecks(workspaceId, id, "https://acme.example/old", [{ day: "2026-05-08", verdict: "PASS" }, { day: "2026-10-01", verdict: "FAIL" }]);
    await storeChecks(workspaceId, id, "https://acme.example/edge", [{ day: "2026-05-09", verdict: "PASS" }, { day: "2026-10-01", verdict: "FAIL" }]);
    const [indexing] = await indexingOf(db, workspaceId, id, NOW);
    expect(indexing).toMatchObject({ checked: 2, indexed: 0, notIndexed: 2 });
    expect(indexing.dropped.map(({ url }) => url)).toEqual(["https://acme.example/edge"]);
  });

  it("gives each site its own, and its sitemaps per engine, for the whole workspace", async () => {
    const { workspaceId, site: { id } } = await followedOnGoogle();
    const other = await followSite(db, workspaceId, "northwind.example");
    await storeChecks(workspaceId, id, ACME_PAGE, [{ day: "2026-10-01", verdict: "PASS" }]);
    await withWorkspace(db, workspaceId, (tx) => tx.insert(sitemap).values([{ siteId: other.id, engine: "google", url: "https://northwind.example/b.xml", urls: 3 }, { siteId: other.id, engine: "bing", url: "https://northwind.example/a.xml", urls: 2 }]));
    const indexing = await indexingOf(db, workspaceId, null, NOW);
    expect(indexing.map(({ siteName, checked, sitemaps }) => [siteName, checked, sitemaps.map(({ engine, url }) => [engine, url])])).toEqual([
      ["acme.example", 1, []],
      ["northwind.example", 0, [["bing", "https://northwind.example/a.xml"], ["google", "https://northwind.example/b.xml"]]],
    ]);
  });

  it("says nothing of another workspace's site", async () => {
    const mine = await followedOnGoogle();
    const theirs = await followedOnGoogle("northwind.example");
    await storeChecks(theirs.workspaceId, theirs.site.id, "https://northwind.example/a", [{ day: "2026-10-01", verdict: "PASS" }]);
    expect(await indexingOf(db, mine.workspaceId, theirs.site.id, NOW)).toEqual([]);
    expect((await indexingOf(db, mine.workspaceId, null, NOW)).map(({ siteName }) => siteName)).toEqual(["acme.example"]);
  });
});

describe("asking Google about one page", () => {
  const refusedAddresses = ["https://northwind.example/pricing", "https://notacme.example/", "https://acme.example.northwind.example/", "not an address"];

  it("says what Google says, for this site and its subdomains", async () => {
    const { workspaceId, site: { id } } = await followedOnGoogle();
    const { services, calls } = testServices(db, [GOOGLE_TOKEN, PASSING]);
    for (const url of [ACME_PAGE, "https://www.acme.example/", "https://blog.acme.example/post"]) {
      expect(await inspectPage(services, workspaceId, id, url)).toEqual({ ok: true, inspection: { verdict: "PASS", coverage: "Submitted and indexed", lastCrawlAt: new Date("2026-11-01T06:00:00Z") } });
    }
    expect(inspections(calls)).toHaveLength(3);
    expect(await checksIn(workspaceId)).toEqual([]);
  });

  it.each(refusedAddresses)("refuses %s, without asking Google", async (url) => {
    const { workspaceId, site: { id } } = await followedOnGoogle();
    const { services, calls } = testServices(db, [GOOGLE_TOKEN, PASSING]);
    expect(await inspectPage(services, workspaceId, id, url)).toEqual({ ok: false, error: "That address isn’t on acme.example." });
    expect(calls).toEqual([]);
  });

  it("refuses another workspace's site, one not on Google, and a made-up one", async () => {
    const mine = await followedOnGoogle();
    const theirs = await followedOnGoogle("northwind.example");
    const onBing = await followSite(db, mine.workspaceId, "third.example", { googleProperty: null, bingSite: "https://third.example/" });
    const refused = { ok: false, error: "This site isn’t on Google here." };
    const { services, calls } = testServices(db, [GOOGLE_TOKEN, PASSING]);
    expect(await inspectPage(services, mine.workspaceId, theirs.site.id, "https://northwind.example/a")).toEqual(refused);
    expect(await inspectPage(services, mine.workspaceId, onBing.id, "https://third.example/a")).toEqual(refused);
    expect(await inspectPage(services, mine.workspaceId, "not-an-id", ACME_PAGE)).toEqual(refused);
    expect(calls).toEqual([]);
  });

  it("asks to connect Google when nothing's connected", async () => {
    const seat = await createTestWorkspace(db);
    const row = await followSite(db, seat.workspaceId);
    expect(await inspectPage(testServices(db).services, seat.workspaceId, row.id, ACME_PAGE)).toEqual({ ok: false, error: "Connect Google first." });
  });

  it("says what Google refused", async () => {
    const { workspaceId, site: { id } } = await followedOnGoogle();
    const { services } = testServices(db, [GOOGLE_TOKEN, { match: INSPECT, status: 403, json: { message: "No access" } }]);
    expect(await inspectPage(services, workspaceId, id, ACME_PAGE)).toEqual({ ok: false, error: "Google refused access: No access" });
  });
});

describe("submitting a sitemap", () => {
  const SITEMAP = "https://acme.example/sitemap.xml";
  const putTo = googleSitemapAddress("sc-domain:acme.example", SITEMAP);
  const accepting: FakeRoute[] = [{ match: `PUT ${putTo}`, json: {} }, ...googleProperty("sc-domain:acme.example", { sitemaps: [{ path: SITEMAP, lastSubmitted: "2026-11-05T09:00:00Z", contents: [{ submitted: 7 }] }] }), GOOGLE_TOKEN];

  it("tells Google, then keeps what Google now says of it", async () => {
    const { workspaceId, userId, site: { id } } = await followedOnGoogle();
    const { services, calls } = testServices(db, accepting);
    expect(await submitSitemap(services, workspaceId, userId, id, "google", SITEMAP)).toEqual({ ok: true, said: "Submitted." });
    expect(calls.filter(({ method }) => method === "PUT").map(({ url }) => url)).toEqual([putTo]);
    expect(await withWorkspace(db, workspaceId, (tx) => tx.select().from(sitemap))).toMatchObject([{ siteId: id, engine: "google", url: SITEMAP, urls: 7, submittedAt: NOW }]);
  });

  it("tells Bing the same way", async () => {
    const seat = await createTestWorkspace(db);
    await connectBing(testServices(db).services, seat.workspaceId, seat.userId);
    const row = await followSite(db, seat.workspaceId, "acme.example", { googleProperty: null, bingSite: "https://www.acme.example/" });
    const { services, calls } = testServices(db, [{ match: "POST https://ssl.bing.com/webmaster/api.svc/json/SubmitFeed", json: { d: null } }, ...bingFigures([], [{ Url: SITEMAP, UrlCount: 4 }])]);
    expect(await submitSitemap(services, seat.workspaceId, seat.userId, row.id, "bing", SITEMAP)).toEqual({ ok: true, said: "Submitted." });
    expect(JSON.parse(calls[0].body)).toEqual({ siteUrl: "https://www.acme.example/", feedUrl: SITEMAP });
    expect(await withWorkspace(db, seat.workspaceId, (tx) => tx.select().from(sitemap))).toMatchObject([{ engine: "bing", url: SITEMAP, urls: 4 }]);
  });

  it("is refused to a plain member and to someone from elsewhere, before anything is asked", async () => {
    const { workspaceId, site: { id } } = await followedOnGoogle();
    const { userId: outsider } = await createTestWorkspace(db, "Elsewhere");
    const { services, calls } = testServices(db, accepting);
    for (const asker of [await teammate(db, workspaceId), outsider]) expect(await submitSitemap(services, workspaceId, asker, id, "google", SITEMAP)).toEqual({ ok: false, error: NOT_A_MANAGER_OF_SETTINGS });
    expect(calls).toEqual([]);
  });

  it.each(["https://northwind.example/sitemap.xml", "https://notacme.example/sitemap.xml", "nonsense"])("refuses %s, an address not on this site, without asking", async (url) => {
    const { workspaceId, userId, site: { id } } = await followedOnGoogle();
    const { services, calls } = testServices(db, accepting);
    expect(await submitSitemap(services, workspaceId, userId, id, "google", url)).toEqual({ ok: false, error: "That address isn’t on acme.example." });
    expect(calls).toEqual([]);
  });

  it("refuses a site not on that engine, and another workspace's", async () => {
    const mine = await followedOnGoogle();
    const theirs = await followedOnGoogle("northwind.example");
    const refused = { ok: false, error: "This site isn’t on that engine here." };
    expect(await submitSitemap(testServices(db).services, mine.workspaceId, mine.userId, mine.site.id, "bing", SITEMAP)).toEqual(refused);
    expect(await submitSitemap(testServices(db).services, mine.workspaceId, mine.userId, theirs.site.id, "google", "https://northwind.example/sitemap.xml")).toEqual(refused);
  });

  it("says when that engine isn't connected", async () => {
    const seat = await createTestWorkspace(db);
    const row = await followSite(db, seat.workspaceId);
    expect(await submitSitemap(testServices(db).services, seat.workspaceId, seat.userId, row.id, "google", SITEMAP)).toEqual({ ok: false, error: "That engine isn’t connected." });
  });

  it("says what the engine refused, and keeps the sitemaps it knew", async () => {
    const { workspaceId, userId, site: { id } } = await followedOnGoogle();
    await withWorkspace(db, workspaceId, (tx) => tx.insert(sitemap).values({ siteId: id, engine: "google", url: SITEMAP }));
    const { services } = testServices(db, [{ match: `PUT ${putTo}`, status: 403, json: { message: "No access" } }, GOOGLE_TOKEN]);
    expect(await submitSitemap(services, workspaceId, userId, id, "google", SITEMAP)).toEqual({ ok: false, error: "Google refused access: No access" });
    expect(await withWorkspace(db, workspaceId, (tx) => tx.select().from(sitemap))).toHaveLength(1);
  });
});
