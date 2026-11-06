import { logFailure } from "@/infrastructure/logging/failures";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { KeywordsAndPages } from "@/application/ports";
import type { Services } from "@/application/services";
import { connectionsOf, connectWithFields } from "@/application/connections";
import { sitesOf } from "@/application/sites";
import { syncDueSites } from "@/application/sync";
import { adapterOf } from "@/infrastructure/connectors";
import { bingMoment } from "@/infrastructure/connectors/bing";
import { isQuota, isRefusal, ProviderError, requestJson, withRetries } from "@/infrastructure/connectors/http";
import type { Database } from "@/infrastructure/db/client";
import { keyword, keywordDay, page, pageDay, searchDay, site, sitemap } from "@/infrastructure/db/schema/search";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { fakeFetch, type RecordedCall } from "./support/fetch";
import { BING_SITES, bingFigures, connectBing, connectGoogle, followSite, GOOGLE_TOKEN, GOOGLE_USER, googleProperty, googlePropertyFailing, NEXT_DAY, NOW, servicesRunningOutOfTime, testServices, testSettings } from "./support/search";

const ACME = "sc-domain:acme.example";
const NORTHWIND = "sc-domain:northwind.example";
const FIRST_OF_NOVEMBER = "/Date(1793491200000)/";
const THIRD_OF_NOVEMBER = "/Date(1793664000000)/";

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
});
// The job reads every workspace, so each test starts with no site.
beforeEach(async () => {
  await db.delete(site);
});

/** A workspace with Google connected and allowed, following one site on it. */
async function onGoogle(name = "acme.example") {
  const seat = await createTestWorkspace(db);
  await connectGoogle(testServices(db).services, seat.workspaceId, seat.userId);
  return { ...seat, site: await followSite(db, seat.workspaceId, name) };
}

/** A workspace with Bing connected, following one site on it. */
async function onBing(name = "acme.example") {
  const seat = await createTestWorkspace(db);
  await connectBing(testServices(db).services, seat.workspaceId, seat.userId);
  return { ...seat, site: await followSite(db, seat.workspaceId, name, { googleProperty: null, bingSite: `https://www.${name}/` }) };
}

const read = (routes: Parameters<typeof testServices>[1], now = NOW) => {
  const { services, calls } = testServices(db, routes, now);
  return { report: syncDueSites(services, now.getTime() + 3_600_000), calls };
};

type Stored = typeof searchDay | typeof keyword | typeof keywordDay | typeof page | typeof pageDay | typeof sitemap;
const rows = <T extends Stored>(workspaceId: string, table: T) => withWorkspace(db, workspaceId, (tx) => tx.select().from(table as never)) as Promise<T["$inferSelect"][]>;
const siteRow = async (workspaceId: string) => (await sitesOf(db, workspaceId))[0];

/** What each Search Analytics question asked for, by its dimensions. */
const asked = (calls: RecordedCall[]) =>
  calls
    .filter(({ url }) => url.endsWith("/searchAnalytics/query"))
    .map(({ body }) => JSON.parse(body) as { dimensions: string[]; startDate: string; endDate: string })
    .map(({ dimensions, startDate, endDate }) => [dimensions.join("+"), startDate, endDate]);

describe("how far back a read asks", () => {
  it("is 480 days of totals and 90 of keywords and pages, the first time, in slices of 14 days", async () => {
    await onGoogle();
    const { report, calls } = read([...googleProperty(ACME), GOOGLE_TOKEN]);
    expect(await report).toEqual({ synced: 1, failed: 0, left: 0 });
    // From 5 November 2026: 480 days back is 13 July 2025, and 90 is 7 August 2026.
    const all = asked(calls);
    expect(all.filter(([kind]) => kind === "date")).toEqual([["date", "2025-07-13", "2026-11-05"]]);
    const keywords = all.filter(([kind]) => kind === "query+date");
    expect(keywords).toHaveLength(7);
    expect(keywords[0]).toEqual(["query+date", "2026-08-07", "2026-08-20"]);
    expect(keywords.at(-1)).toEqual(["query+date", "2026-10-30", "2026-11-05"]);
    expect(all.filter(([kind]) => kind === "page+date")).toHaveLength(7);
  });

  it("is 10 days before the last read the next time, engines reporting late", async () => {
    await onGoogle();
    await read([...googleProperty(ACME), GOOGLE_TOKEN]).report;
    const { report, calls } = read([...googleProperty(ACME), GOOGLE_TOKEN], NEXT_DAY);
    expect(await report).toEqual({ synced: 1, failed: 0, left: 0 });
    // Read last on 5 November 2026: 10 days before that is 26 October.
    expect(asked(calls)).toEqual([
      ["date", "2026-10-26", "2026-11-06"],
      ["query+date", "2026-10-26", "2026-11-06"],
      ["page+date", "2026-10-26", "2026-11-06"],
    ]);
  });
});

describe("what a read from Google leaves", () => {
  const answers = {
    totals: [{ keys: ["2026-11-01"], clicks: 3, impressions: 60, position: 7.5 }],
    keywords: [{ keys: ["acme pricing", "2026-11-01"], clicks: 2, impressions: 40, position: 4.5 }],
    pages: [{ keys: ["https://acme.example/pricing", "2026-11-01"], clicks: 1, impressions: 20, position: 2.5 }],
    sitemaps: [{ path: "https://acme.example/sitemap.xml", lastSubmitted: "2026-10-01T00:00:00Z", lastDownloaded: "2026-10-02T00:00:00Z", errors: "1", warnings: "2", contents: [{ submitted: "10" }, { submitted: "5" }] }],
  };

  it("puts each number in its own table", async () => {
    const { workspaceId, site: { id: siteId } } = await onGoogle();
    await read([...googleProperty(ACME, answers), GOOGLE_TOKEN]).report;
    const [word] = await rows(workspaceId, keyword);
    const [address] = await rows(workspaceId, page);
    expect(await rows(workspaceId, searchDay)).toEqual([{ workspaceId, siteId, day: "2026-11-01", engine: "google", clicks: 3, impressions: 60, position: 7.5 }]);
    expect(word).toMatchObject({ siteId, text: "acme pricing" });
    expect(await rows(workspaceId, keywordDay)).toEqual([{ workspaceId, siteId, keywordId: word.id, day: "2026-11-01", clicks: 2, impressions: 40, position: 4.5 }]);
    expect(address).toMatchObject({ siteId, url: "https://acme.example/pricing", inspectedAt: null });
    expect(await rows(workspaceId, pageDay)).toEqual([{ workspaceId, siteId, pageId: address.id, day: "2026-11-01", clicks: 1, impressions: 20, position: 2.5 }]);
    expect(await rows(workspaceId, sitemap)).toEqual([{ workspaceId, siteId, engine: "google", url: "https://acme.example/sitemap.xml", submittedAt: new Date("2026-10-01T00:00:00Z"), lastReadAt: new Date("2026-10-02T00:00:00Z"), errors: 1, warnings: 2, urls: 15 }]);
  });

  it("says the site was read, and when", async () => {
    const { workspaceId } = await onGoogle();
    await read([...googleProperty(ACME, answers), GOOGLE_TOKEN]).report;
    expect(await siteRow(workspaceId)).toMatchObject({ lastSyncedAt: NOW, lastSyncError: null });
  });

  it("replaces what it said of a day the second time, rather than adding to it", async () => {
    const { workspaceId } = await onGoogle();
    await read([...googleProperty(ACME, answers), GOOGLE_TOKEN]).report;
    const settled = {
      totals: [{ ...answers.totals[0], clicks: 5, impressions: 80, position: 6.5 }],
      keywords: [{ ...answers.keywords[0], clicks: 4, impressions: 50, position: 3.5 }],
      pages: [{ ...answers.pages[0], clicks: 3, impressions: 30, position: 1.5 }],
    };
    await read([...googleProperty(ACME, settled), GOOGLE_TOKEN], NEXT_DAY).report;
    expect(await rows(workspaceId, searchDay)).toMatchObject([{ clicks: 5, impressions: 80, position: 6.5 }]);
    expect(await rows(workspaceId, keywordDay)).toMatchObject([{ clicks: 4, impressions: 50, position: 3.5 }]);
    expect(await rows(workspaceId, pageDay)).toMatchObject([{ clicks: 3, impressions: 30, position: 1.5 }]);
    expect(await rows(workspaceId, keyword)).toHaveLength(1);
    expect(await rows(workspaceId, page)).toHaveLength(1);
  });

  it("keeps earlier days as they were, adding the new one", async () => {
    const { workspaceId } = await onGoogle();
    await read([...googleProperty(ACME, answers), GOOGLE_TOKEN]).report;
    await read([...googleProperty(ACME, { totals: [{ keys: ["2026-11-05"], clicks: 9, impressions: 90, position: 3 }] }), GOOGLE_TOKEN], NEXT_DAY).report;
    expect((await rows(workspaceId, searchDay)).map(({ day, clicks }) => [day, clicks]).sort()).toEqual([["2026-11-01", 3], ["2026-11-05", 9]]);
  });

  it("takes one row a day when an engine repeats itself in one answer", async () => {
    const { workspaceId } = await onGoogle();
    const twice = { keywords: [answers.keywords[0], { ...answers.keywords[0], clicks: 9 }], pages: [answers.pages[0], { ...answers.pages[0], clicks: 9 }] };
    expect(await read([...googleProperty(ACME, twice), GOOGLE_TOKEN]).report).toEqual({ synced: 1, failed: 0, left: 0 });
    expect(await rows(workspaceId, keywordDay)).toMatchObject([{ clicks: 9 }]);
    expect(await rows(workspaceId, pageDay)).toMatchObject([{ clicks: 9 }]);
  });

  it("copes with more rows than fit in one statement", async () => {
    const { workspaceId } = await onGoogle();
    const many = Array.from({ length: 501 }, (_, index) => ({ keys: [`keyword ${index}`, "2026-11-01"], clicks: 1, impressions: 2, position: 3 }));
    await read([...googleProperty(ACME, { keywords: many }), GOOGLE_TOKEN]).report;
    expect(await rows(workspaceId, keyword)).toHaveLength(501);
    expect(await rows(workspaceId, keywordDay)).toHaveLength(501);
  });

  it("replaces the sitemaps: one the engine no longer lists is gone", async () => {
    const { workspaceId } = await onGoogle();
    const another = { path: "https://acme.example/news.xml" };
    await read([...googleProperty(ACME, { sitemaps: [answers.sitemaps[0], another] }), GOOGLE_TOKEN]).report;
    expect((await rows(workspaceId, sitemap)).map(({ url }) => url).sort()).toEqual(["https://acme.example/news.xml", "https://acme.example/sitemap.xml"]);
    await read([...googleProperty(ACME, { sitemaps: [another] }), GOOGLE_TOKEN], NEXT_DAY).report;
    expect(await rows(workspaceId, sitemap)).toMatchObject([{ url: "https://acme.example/news.xml", errors: 0, warnings: 0, urls: 0, submittedAt: null, lastReadAt: null }]);
  });
});

describe("what a read from Bing leaves", () => {
  it("is a date as Bing writes it", () => {
    expect(bingMoment("/Date(1609459200000)/")).toEqual(new Date("2021-01-01T00:00:00.000Z"));
    expect(bingMoment("/Date(1609459200000-0700)/")).toEqual(new Date("2021-01-01T00:00:00.000Z"));
    expect(bingMoment("yesterday")).toBeNull();
    expect(bingMoment(undefined)).toBeNull();
  });

  it("reads the days within the period, each once, with no position", async () => {
    const { workspaceId, site: { id: siteId } } = await onBing();
    const days = [
      { Date: FIRST_OF_NOVEMBER, Clicks: 3, Impressions: 30 },
      { Date: FIRST_OF_NOVEMBER, Clicks: 2, Impressions: 20 },
      { Date: THIRD_OF_NOVEMBER, Clicks: 7, Impressions: 70 },
      { Date: "/Date(1609459200000)/", Clicks: 100, Impressions: 1000 },
      { Clicks: 100, Impressions: 1000 } as never,
    ];
    expect(await read(bingFigures(days)).report).toEqual({ synced: 1, failed: 0, left: 0 });
    expect((await rows(workspaceId, searchDay)).sort((a, b) => a.day.localeCompare(b.day))).toEqual([
      { workspaceId, siteId, day: "2026-11-01", engine: "bing", clicks: 5, impressions: 50, position: null },
      { workspaceId, siteId, day: "2026-11-03", engine: "bing", clicks: 7, impressions: 70, position: null },
    ]);
  });

  it("asks about the site by what Bing calls it, with the key", async () => {
    await onBing();
    const { report, calls } = read(bingFigures());
    await report;
    const stats = new URL(calls[0].url);
    expect(stats.pathname).toBe("/webmaster/api.svc/json/GetRankAndTrafficStats");
    expect(Object.fromEntries(stats.searchParams)).toEqual({ apikey: "a-bing-key", siteUrl: "https://www.acme.example/" });
  });

  it("has no keywords or pages to read, and its sitemaps are read as Bing lists them", async () => {
    const { workspaceId, site: { id: siteId } } = await onBing();
    const feeds = [{ Url: "https://www.acme.example/sitemap.xml", Submitted: FIRST_OF_NOVEMBER, LastCrawled: THIRD_OF_NOVEMBER, UrlCount: 12 }, { UrlCount: 3 }];
    await read(bingFigures([], feeds)).report;
    expect(await rows(workspaceId, keyword)).toEqual([]);
    expect(await rows(workspaceId, sitemap)).toEqual([{ workspaceId, siteId, engine: "bing", url: "https://www.acme.example/sitemap.xml", submittedAt: new Date("2026-11-01T00:00:00Z"), lastReadAt: new Date("2026-11-03T00:00:00Z"), errors: 0, warnings: 0, urls: 12 }]);
  });
});

describe("a site on both engines", () => {
  it("gets a row per engine for the same day", async () => {
    const seat = await createTestWorkspace(db);
    const { services } = testServices(db);
    await connectGoogle(services, seat.workspaceId, seat.userId);
    await connectBing(services, seat.workspaceId, seat.userId);
    await followSite(db, seat.workspaceId, "acme.example", { bingSite: "https://www.acme.example/" });
    const routes = [...googleProperty(ACME, { totals: [{ keys: ["2026-11-01"], clicks: 3, impressions: 60, position: 7.5 }] }), GOOGLE_TOKEN, ...bingFigures([{ Date: FIRST_OF_NOVEMBER, Clicks: 2, Impressions: 20 }])];
    expect(await read(routes).report).toEqual({ synced: 1, failed: 0, left: 0 });
    expect((await rows(seat.workspaceId, searchDay)).map(({ engine, clicks }) => [engine, clicks]).sort()).toEqual([["bing", 2], ["google", 3]]);
  });

  it("is read as far as it can be when one engine's key has ended, the other not asked again today", async () => {
    const seat = await createTestWorkspace(db);
    const { services } = testServices(db);
    await connectGoogle(services, seat.workspaceId, seat.userId);
    await connectBing(services, seat.workspaceId, seat.userId);
    await followSite(db, seat.workspaceId, "acme.example", { bingSite: "https://www.acme.example/" });
    const routes = [...googleProperty(ACME), GOOGLE_TOKEN, { match: "GET https://ssl.bing.com/webmaster/api.svc/json/GetRankAndTrafficStats", status: 401, json: { message: "Key ended" } }];
    expect(await read(routes).report).toEqual({ synced: 1, failed: 0, left: 0 });
    expect(await siteRow(seat.workspaceId)).toMatchObject({ lastSyncedAt: NOW, lastSyncError: "Bing refused the credentials: Key ended", lastReadFailed: false });
    const views = await connectionsOf(services, seat.workspaceId);
    expect(views.find(({ kind }) => kind === "bing")).toMatchObject({ status: "failing", lastError: "Bing refused the credentials: Key ended" });
    expect(views.find(({ kind }) => kind === "google")).toMatchObject({ status: "connected", lastError: null });
    expect(await read(routes).report).toEqual({ synced: 0, failed: 0, left: 0 });
  });

  it("stays due when one engine is only failing for now, and the other isn't read twice", async () => {
    const seat = await createTestWorkspace(db);
    const { services } = testServices(db);
    await connectGoogle(services, seat.workspaceId, seat.userId);
    await connectBing(services, seat.workspaceId, seat.userId);
    await followSite(db, seat.workspaceId, "acme.example", { bingSite: "https://www.acme.example/" });
    const bingDown = { match: "GET https://ssl.bing.com/webmaster/api.svc/json/GetRankAndTrafficStats", status: 503, json: { message: "Back soon" } };
    expect(await read([...googleProperty(ACME), GOOGLE_TOKEN, bingDown]).report).toEqual({ synced: 0, failed: 1, left: 0 });
    expect(await siteRow(seat.workspaceId)).toMatchObject({ lastSyncedAt: null, lastReadFailed: true });
    const again = read(bingFigures());
    expect(await again.report).toEqual({ synced: 1, failed: 0, left: 0 });
    expect(again.calls.some(({ url }) => url.includes("googleapis"))).toBe(false);
  });

});

describe("two accounts on one engine", () => {
  const ANALYTICS = `POST https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(ACME)}/searchAnalytics/query`;
  const SITEMAPS = `GET https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(ACME)}/sitemaps`;
  const TOKEN = GOOGLE_TOKEN.match;
  const row = { keys: ["2026-11-01"], clicks: 3, impressions: 60, position: 7.5 };

  /** Each account's lasting token gets it its own access token. */
  const tokens = [{ match: TOKEN, bodyHas: "refresh_token=token-of-ada", json: { access_token: "ada" } }, { match: TOKEN, bodyHas: "refresh_token=token-of-bea", json: { access_token: "bea" } }];
  const readsFor = (account: string) => [{ match: ANALYTICS, bearer: account, json: { rows: [row] } }, { match: SITEMAPS, bearer: account, json: {} }];
  const refusedFor = (account: string, status: number, message: string) => ({ match: ANALYTICS, bearer: account, status, json: { error: { message } } });

  async function bothConnected() {
    const seat = await createTestWorkspace(db);
    for (const name of ["ada", "bea"]) {
      const { services } = testServices(db, [{ ...GOOGLE_TOKEN, json: { access_token: "an-access-token", refresh_token: `token-of-${name}` } }, { ...GOOGLE_USER, json: { email: `${name}@acme.example` } }]);
      await connectGoogle(services, seat.workspaceId, seat.userId);
    }
    await followSite(db, seat.workspaceId);
    return seat;
  }

  const statusOf = async (workspaceId: string) => (await connectionsOf(testServices(db).services, workspaceId)).map(({ label, status }) => [label, status]);

  it("reads a site through the one that has it, whichever comes first, and neither is failing", async () => {
    const { workspaceId } = await bothConnected();
    expect(await read([...tokens, refusedFor("ada", 403, "No access to this property"), ...readsFor("bea")]).report).toEqual({ synced: 1, failed: 0, left: 0 });
    expect(await rows(workspaceId, searchDay)).toMatchObject([{ clicks: 3 }]);
    expect(await siteRow(workspaceId)).toMatchObject({ lastSyncedAt: NOW, lastSyncError: null });
    expect(await statusOf(workspaceId)).toEqual([["ada@acme.example", "connected"], ["bea@acme.example", "connected"]]);
  });

  it("stops at the first that reads it, not asking the other", async () => {
    const { workspaceId } = await bothConnected();
    const { report, calls } = read([...tokens, ...readsFor("ada")]);
    expect(await report).toEqual({ synced: 1, failed: 0, left: 0 });
    expect(new Set(calls.filter(({ url }) => url.includes("searchAnalytics")).map(({ headers }) => headers.get("authorization")))).toEqual(new Set(["Bearer ada"]));
    expect(await rows(workspaceId, searchDay)).toHaveLength(1);
  });

  it("clears a connection's failure once it reads a site again", async () => {
    const { workspaceId } = await bothConnected();
    await read([...tokens, refusedFor("ada", 401, "Ended"), refusedFor("bea", 403, "No access")]).report;
    expect(await statusOf(workspaceId)).toEqual([["ada@acme.example", "failing"], ["bea@acme.example", "connected"]]);
    const later = read([...tokens, ...readsFor("ada")], NEXT_DAY);
    expect(await later.report).toEqual({ synced: 1, failed: 0, left: 0 });
    expect(await statusOf(workspaceId)).toEqual([["ada@acme.example", "connected"], ["bea@acme.example", "connected"]]);
  });

  it("marks the one whose credentials were refused when neither can read it", async () => {
    const { workspaceId } = await bothConnected();
    const routes = [...tokens, refusedFor("ada", 403, "No access to this property"), refusedFor("bea", 401, "Credentials ended")];
    expect(await read(routes).report).toEqual({ synced: 0, failed: 1, left: 0 });
    expect(await statusOf(workspaceId)).toEqual([["ada@acme.example", "connected"], ["bea@acme.example", "failing"]]);
    expect((await siteRow(workspaceId)).lastSyncError).toBe("Google refused the credentials: Credentials ended");
  });

  it("marks neither when neither has the site: that's about the site, and it's said there", async () => {
    const { workspaceId } = await bothConnected();
    const routes = [...tokens, refusedFor("ada", 403, "No access"), refusedFor("bea", 403, "No access")];
    expect(await read(routes).report).toEqual({ synced: 0, failed: 1, left: 0 });
    expect(await statusOf(workspaceId)).toEqual([["ada@acme.example", "connected"], ["bea@acme.example", "connected"]]);
    expect((await siteRow(workspaceId)).lastSyncError).toBe("Google refused access: No access");
  });
});

describe("a refused key", () => {
  const REFUSED = "Bing refused the credentials: Key ended";
  const refusing = [{ match: "GET https://ssl.bing.com/webmaster/api.svc/json/GetRankAndTrafficStats", status: 401, json: { message: "Key ended" } }];

  it("counts Bing's real answer to a key it doesn't know as refused credentials", async () => {
    const { workspaceId } = await onBing();
    const asBingAnswers = [{ match: refusing[0].match, status: 400, json: { ErrorCode: 3, Message: "ERROR!!! InvalidApiKey" } }];
    expect(await read(asBingAnswers).report).toEqual({ synced: 0, failed: 1, left: 0 });
    expect((await connectionsOf(testServices(db).services, workspaceId))[0]).toMatchObject({ status: "failing", lastError: "Bing refused this key. Check it in Bing Webmaster Tools, under Settings, API Access." });
  });

  it("counts Bing's real answer about a site out of a key's reach as refused access, not a failed account", async () => {
    const { workspaceId } = await onBing();
    const asBingAnswers = [{ match: refusing[0].match, status: 400, json: { ErrorCode: 14, Message: "ERROR!!! NotAuthorized" } }];
    expect(await read(asBingAnswers).report).toEqual({ synced: 0, failed: 1, left: 0 });
    expect((await siteRow(workspaceId)).lastSyncError).toBe("Bing refused this key access to this site.");
  });

  it("asks Bing again when it says to slow down, its 400 naming the throttle", async () => {
    await onBing();
    const throttled = [{ match: refusing[0].match, status: 400, json: { ErrorCode: 4, Message: "ERROR!!! ThrottleUser" } }];
    const { report, calls } = read(throttled);
    expect(await report).toEqual({ synced: 0, failed: 1, left: 0 });
    expect(calls.filter(({ url }) => url.includes("GetRankAndTrafficStats"))).toHaveLength(4);
  });

  it("marks its connection failing and leaves the site due, saying why", async () => {
    const { workspaceId } = await onBing();
    expect(await read(refusing).report).toEqual({ synced: 0, failed: 1, left: 0 });
    expect((await connectionsOf(testServices(db).services, workspaceId))[0]).toMatchObject({ status: "failing", lastError: REFUSED });
    expect(await siteRow(workspaceId)).toMatchObject({ lastSyncedAt: null, lastSyncError: REFUSED });
  });

  it("is tried again on the next run, still as a first read", async () => {
    const { workspaceId } = await onBing();
    await read(refusing).report;
    expect(await read(bingFigures([{ Date: FIRST_OF_NOVEMBER, Clicks: 3, Impressions: 30 }])).report).toEqual({ synced: 1, failed: 0, left: 0 });
    expect(await siteRow(workspaceId)).toMatchObject({ lastSyncedAt: NOW, lastSyncError: null });
    expect(await rows(workspaceId, searchDay)).toHaveLength(1);
  });

  it("stays with its site on Google, a 403 on one property saying nothing of the account", async () => {
    const { workspaceId } = await onGoogle();
    expect(await read([...googlePropertyFailing(ACME, 403, "User does not have sufficient permission"), GOOGLE_TOKEN]).report).toEqual({ synced: 0, failed: 1, left: 0 });
    expect((await connectionsOf(testServices(db).services, workspaceId))[0]).toMatchObject({ status: "connected", lastError: null });
    expect((await siteRow(workspaceId)).lastSyncError).toBe("Google refused access: User does not have sufficient permission");
  });

  it("isn't what a service being down is: the connection stays as it was", async () => {
    const { workspaceId } = await onGoogle();
    expect(await read([...googlePropertyFailing(ACME, 503, "Back soon"), GOOGLE_TOKEN]).report).toEqual({ synced: 0, failed: 1, left: 0 });
    expect((await connectionsOf(testServices(db).services, workspaceId))[0]).toMatchObject({ status: "connected", lastError: null });
    expect((await siteRow(workspaceId)).lastSyncError).toBe("Google isn’t answering properly right now: Back soon");
  });

  it("counts when Google says the lasting token has ended, as it does after 7 days in Testing", async () => {
    const { workspaceId } = await onGoogle();
    const ended = { ...GOOGLE_TOKEN, status: 400, json: { error: "invalid_grant", error_description: "Token has been expired or revoked." } };
    expect(await read([ended]).report).toEqual({ synced: 0, failed: 1, left: 0 });
    expect((await connectionsOf(testServices(db).services, workspaceId))[0]).toMatchObject({ status: "failing", lastError: "Google refused the request: Token has been expired or revoked." });
    expect(await siteRow(workspaceId)).toMatchObject({ lastSyncedAt: null, lastSyncError: "Google refused the request: Token has been expired or revoked." });
  });

  it("is said in plain words when the service can't be reached", async () => {
    const { workspaceId } = await onGoogle();
    expect(await read([GOOGLE_TOKEN]).report).toEqual({ synced: 0, failed: 1, left: 0 });
    expect((await siteRow(workspaceId)).lastSyncError).toBe("Google couldn’t be reached.");
  });

  it("says when the answer makes no sense", async () => {
    const { workspaceId } = await onGoogle();
    const nonsense = [{ match: `POST https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(ACME)}/searchAnalytics/query`, text: "<html>No</html>" }];
    expect(await read([...nonsense, GOOGLE_TOKEN]).report).toEqual({ synced: 0, failed: 1, left: 0 });
    expect((await siteRow(workspaceId)).lastSyncError).toBe("Google gave an answer that can’t be read.");
  });
});

describe("one site failing", () => {
  it("doesn't stop the next, in its workspace or another", async () => {
    const seat = await onGoogle("acme.example");
    const sameWorkspace = await followSite(db, seat.workspaceId, "northwind.example");
    const elsewhere = await onBing("third.example");
    const routes = [...googlePropertyFailing(ACME, 500, "Broken"), ...googleProperty(NORTHWIND, { totals: [{ keys: ["2026-11-01"], clicks: 1, impressions: 2, position: 3 }] }), GOOGLE_TOKEN, ...bingFigures([{ Date: FIRST_OF_NOVEMBER, Clicks: 4, Impressions: 5 }])];
    expect(await read(routes).report).toEqual({ synced: 2, failed: 1, left: 0 });
    const bySite = await sitesOf(db, seat.workspaceId);
    expect(bySite.map(({ name, lastSyncedAt }) => [name, lastSyncedAt])).toEqual([["acme.example", null], ["northwind.example", NOW]]);
    expect(await rows(seat.workspaceId, searchDay)).toMatchObject([{ siteId: sameWorkspace.id, clicks: 1 }]);
    expect(await rows(elsewhere.workspaceId, searchDay)).toMatchObject([{ siteId: elsewhere.site.id, clicks: 4 }]);
  });
});

describe("a deadline", () => {
  const healthy = [...googleProperty(ACME), ...googleProperty(NORTHWIND), GOOGLE_TOKEN];

  async function twoSites() {
    const seat = await onGoogle("acme.example");
    await followSite(db, seat.workspaceId, "northwind.example");
    return seat;
  }

  it("leaves the rest for next time and says how many, the reads already under way finishing", async () => {
    const { workspaceId } = await twoSites();
    const more = ["one", "two", "three", "four"];
    for (const name of more) await followSite(db, workspaceId, `${name}.example`);
    const all = [...more.flatMap((name) => googleProperty(`sc-domain:${name}.example`)), ...healthy];
    const deadline = NOW.getTime() + 60_000;
    const { services } = servicesRunningOutOfTime(db, all, deadline);
    expect(await syncDueSites(services, deadline)).toEqual({ synced: 4, failed: 0, left: 2 });
    expect((await sitesOf(db, workspaceId)).filter(({ lastSyncedAt }) => lastSyncedAt === null)).toHaveLength(2);
    expect(await read(all).report).toEqual({ synced: 2, failed: 0, left: 0 });
    expect((await sitesOf(db, workspaceId)).filter(({ lastSyncedAt }) => lastSyncedAt === null)).toEqual([]);
  });

  it("already past starts nothing", async () => {
    await twoSites();
    const { services, calls } = testServices(db, healthy);
    expect(await syncDueSites(services, NOW.getTime())).toEqual({ synced: 0, failed: 0, left: 2 });
    expect(calls).toEqual([]);
  });
});

describe("which sites are due", () => {
  it("isn't one read today", async () => {
    await onGoogle();
    await read([...googleProperty(ACME), GOOGLE_TOKEN]).report;
    const { report, calls } = read([...googleProperty(ACME), GOOGLE_TOKEN], new Date("2026-11-05T23:59:00Z"));
    expect(await report).toEqual({ synced: 0, failed: 0, left: 0 });
    expect(calls).toEqual([]);
  });

  it("is one read yesterday, from the first moment of the day in UTC", async () => {
    await onGoogle();
    await read([...googleProperty(ACME), GOOGLE_TOKEN]).report;
    expect(await read([...googleProperty(ACME), GOOGLE_TOKEN], new Date("2026-11-06T00:00:00Z")).report).toEqual({ synced: 1, failed: 0, left: 0 });
  });

  it("puts a site never read before one read long ago, so a new one doesn't wait behind them all", async () => {
    const old = await onGoogle("northwind.example");
    await withWorkspace(db, old.workspaceId, (tx) => tx.update(site).set({ lastSyncedAt: new Date("2026-11-01T09:00:00Z") }));
    await followSite(db, old.workspaceId, "acme.example");
    const { report, calls } = read([...googleProperty(ACME), ...googleProperty(NORTHWIND), GOOGLE_TOKEN]);
    await report;
    const firstQuery = calls.find(({ url }) => url.endsWith("/searchAnalytics/query"));
    expect(firstQuery?.url).toContain(encodeURIComponent(ACME));
  });

  it("is said, and stays so, when no connected account can read it", async () => {
    const seat = await createTestWorkspace(db);
    await followSite(db, seat.workspaceId);
    const { report, calls } = read(bingFigures());
    expect(await report).toEqual({ synced: 0, failed: 1, left: 0 });
    expect(calls).toEqual([]);
    expect(await siteRow(seat.workspaceId)).toMatchObject({ lastSyncedAt: null, lastSyncError: "No connected account can read this site." });
  });

  it("still gets its first read from the start when an account comes later", async () => {
    const seat = await createTestWorkspace(db);
    await followSite(db, seat.workspaceId);
    await read([]).report;
    await connectGoogle(testServices(db).services, seat.workspaceId, seat.userId);
    const { report, calls } = read([...googleProperty(ACME), GOOGLE_TOKEN], NEXT_DAY);
    expect(await report).toEqual({ synced: 1, failed: 0, left: 0 });
    expect(asked(calls)[0]).toEqual(["date", "2025-07-14", "2026-11-06"]);
    expect(await siteRow(seat.workspaceId)).toMatchObject({ lastSyncedAt: NEXT_DAY, lastSyncError: null });
  });

  it("doesn't count an account that's still waiting for consent", async () => {
    const seat = await createTestWorkspace(db);
    await connectWithFields(testServices(db).services, seat.workspaceId, seat.userId, "google", { clientId: "a-client", clientSecret: "a-secret" });
    await followSite(db, seat.workspaceId);
    expect(await read([]).report).toEqual({ synced: 0, failed: 1, left: 0 });
  });
});

describe("asking a service again", () => {
  const failing = (status: number, message = "Nope") => new ProviderError("Google", status, message);

  /** Fails with these, then answers; what was waited, and how many tries it took. */
  function flaky(...failures: ProviderError[]) {
    const waits: number[] = [];
    const send = vi.fn(async () => {
      const failure = failures.shift();
      if (failure) throw failure;
      return "answered";
    });
    return { send, waits, wait: async (ms: number) => void waits.push(ms) };
  }

  it("waits and tries again when told to slow down, each wait twice the last", async () => {
    const { send, waits, wait } = flaky(failing(429), failing(429), failing(429));
    expect(await withRetries(wait, send)).toBe("answered");
    expect(send).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([2_000, 4_000, 8_000]);
  });

  it.each([500, 502, 503, 599])("waits and tries again after a %d", async (status) => {
    const { send, waits, wait } = flaky(failing(status));
    expect(await withRetries(wait, send)).toBe("answered");
    expect(waits).toEqual([2_000]);
  });

  it("gives up after four tries, with the last failure", async () => {
    const last = failing(503, "Still down");
    const { send, waits, wait } = flaky(failing(503), failing(503), failing(503), last, failing(503));
    await expect(withRetries(wait, send)).rejects.toBe(last);
    expect(send).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([2_000, 4_000, 8_000]);
  });

  it.each([400, 401, 403, 404])("doesn't try again after a %d that says nothing of quota", async (status) => {
    const refused = failing(status, "Forbidden");
    const { send, waits, wait } = flaky(refused);
    await expect(withRetries(wait, send)).rejects.toBe(refused);
    expect(send).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it.each(["Quota exceeded for this property", "Rate limit reached", "ratelimit", "Request was throttled"])("tries again after a 403 saying %j", async (message) => {
    const { send, waits, wait } = flaky(failing(403, message));
    expect(await withRetries(wait, send)).toBe("answered");
    expect(waits).toEqual([2_000]);
  });

  it("doesn't try again after anything that isn't a service's answer", async () => {
    const send = vi.fn(async () => {
      throw new Error("No network");
    });
    await expect(withRetries(async () => {}, send)).rejects.toThrow("No network");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("is what a read goes through: a 429 waits, and the read goes on", async () => {
    const waits: number[] = [];
    let tried = 0;
    const network = fakeFetch([BING_SITES]);
    const fetchOnce429 = (async (...request: Parameters<typeof fetch>) => (tried++ === 0 ? new Response(JSON.stringify({ message: "Slow down" }), { status: 429 }) : network.fetch(...request))) as typeof fetch;
    const client = adapterOf("bing")({ fields: { apiKey: "a-bing-key" }, fetch: fetchOnce429, wait: async (ms) => void waits.push(ms) });
    expect(await client.properties?.()).toEqual([{ id: "https://www.acme.example/", domain: "acme.example" }]);
    expect(waits).toEqual([2_000]);
  });
});

describe("what a service's refusal says", () => {
  const answering = (status: number, json?: unknown, text?: string) => requestJson(fakeFetch([{ match: "GET https://service.example", status, json, text }]).fetch, "Service", "https://service.example");
  const said = (promise: Promise<unknown>) => promise.then(() => "", (error: Error) => error.message);

  it.each([
    [400, "Service refused the request."],
    [401, "Service refused the credentials."],
    [403, "Service refused access."],
    [404, "Service can’t find what was asked for."],
    [429, "Service is limiting requests: try again in a moment."],
    [500, "Service isn’t answering properly right now."],
    [418, "Service answered 418."],
  ])("for a %d is in the member's words", async (status, words) => {
    expect(await said(answering(status))).toBe(words);
  });

  it.each([
    [{ message: "Top level" }, "Top level"],
    [{ error_description: "Described" }, "Described"],
    [{ error: { message: "Nested" } }, "Nested"],
    [{ error: { text: "As text" } }, "As text"],
    [{ errors: [{ message: "In a list" }] }, "In a list"],
    [{ error: "Plain" }, "Plain"],
    [{ detail: "Detailed" }, "Detailed"],
    [{ title: "Titled" }, "Titled"],
  ])("keeps the service's own words from %j", async (json, words) => {
    expect(await said(answering(400, json))).toBe(`Service refused the request: ${words}`);
  });

  it("repeats nothing of an answer that isn't JSON, as an error page can hold the request", async () => {
    expect(await said(answering(400, undefined, "Plainly no"))).toBe("Service refused the request.");
  });

  it("reads an empty answer as nothing", async () => {
    expect(await answering(200)).toBeUndefined();
  });
});

describe("Search Console's answers", () => {
  const client = (routes: Parameters<typeof fakeFetch>[0]) => {
    const network = fakeFetch([GOOGLE_TOKEN, ...routes]);
    return { network, api: adapterOf("google")({ fields: { clientId: "c", clientSecret: "s", refreshToken: "r" }, fetch: network.fetch, wait: async () => {} }) };
  };
  const QUERY = `POST https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(ACME)}/searchAnalytics/query`;
  const row = { keys: ["2026-11-01"], clicks: 1, impressions: 2, position: 3 };

  it("are read a page at a time, until one comes back short", async () => {
    const { network, api } = client([
      { match: QUERY, bodyHas: '"startRow":0', json: { rows: Array.from({ length: 25_000 }, () => row) } },
      { match: QUERY, bodyHas: '"startRow":25000', json: { rows: [row] } },
    ]);
    expect(await api.days?.(ACME, "2026-11-01", "2026-11-05")).toHaveLength(25_001);
    expect(network.calls.filter(({ url }) => url.endsWith("/query"))).toHaveLength(2);
  });

  it("stop at four pages for one day, however long they go on: all Google gives of it", async () => {
    const { network, api } = client([{ match: QUERY, json: { rows: Array.from({ length: 25_000 }, () => row) } }]);
    expect(await api.days?.(ACME, "2026-11-01", "2026-11-01")).toHaveLength(100_000);
    expect(network.calls.filter(({ url }) => url.endsWith("/query"))).toHaveLength(4);
  });

  it("read a longer stretch that fills them again in halves, down to single days", async () => {
    const { network, api } = client([{ match: QUERY, json: { rows: Array.from({ length: 25_000 }, () => row) } }]);
    await api.days?.(ACME, "2026-11-01", "2026-11-02");
    const asked = network.calls.filter(({ url }) => url.endsWith("/query")).map(({ body }) => JSON.parse(body) as { startDate: string; endDate: string });
    expect(asked).toHaveLength(12);
    expect(asked.slice(-1)[0]).toMatchObject({ startDate: "2026-11-02", endDate: "2026-11-02" });
  });

  it("ask only for days Google has finished", async () => {
    const { network, api } = client([{ match: QUERY, json: { rows: [] } }]);
    await api.days?.(ACME, "2026-11-01", "2026-11-05");
    expect(JSON.parse(network.calls.filter(({ url }) => url.endsWith("/query"))[0].body)).not.toHaveProperty("dataState");
  });

  it("leave out a row with no day or no name, and an empty figure is zero", async () => {
    const { api } = client([{ match: QUERY, json: { rows: [{ keys: [] }, { keys: ["2026-11-01"] }] } }]);
    expect(await api.days?.(ACME, "2026-11-01", "2026-11-05")).toEqual([{ day: "2026-11-01", clicks: 0, impressions: 0, position: null }]);
    const { api: named } = client([{ match: QUERY, json: { rows: [{ keys: ["only a name"] }, { keys: ["acme", "2026-11-01"] }] } }]);
    const slices = [];
    for await (const slice of (named as unknown as KeywordsAndPages).keywordSlices(ACME, "2026-11-01", "2026-11-05")) slices.push(slice);
    expect(slices).toEqual([{ days: [{ name: "acme", day: "2026-11-01", clicks: 0, impressions: 0, position: 0 }], through: "2026-11-05" }]);
  });

  it("ask for one access token, however many questions there are", async () => {
    const { network, api } = client([{ match: QUERY, json: { rows: [] } }]);
    await api.days?.(ACME, "2026-11-01", "2026-11-05");
    for await (const slice of (api as unknown as KeywordsAndPages).pageSlices(ACME, "2026-11-01", "2026-11-05")) expect(slice.days).toEqual([]);
    expect(network.calls.filter(({ url }) => url.includes("oauth2"))).toHaveLength(1);
  });

  it("ask for the token again after Google failed to give one", async () => {
    let failed = false;
    const network = fakeFetch([GOOGLE_TOKEN, { match: QUERY, json: { rows: [row] } }]);
    const onceDown = (async (...request: Parameters<typeof fetch>) => {
      if (!failed) {
        failed = true;
        return new Response(JSON.stringify({ message: "Back soon" }), { status: 503 });
      }
      return network.fetch(...request);
    }) as typeof fetch;
    const api = adapterOf("google")({ fields: { clientId: "c", clientSecret: "s", refreshToken: "r" }, fetch: onceDown, wait: async () => {} });
    expect(await api.days?.(ACME, "2026-11-01", "2026-11-05")).toHaveLength(1);
  });

  it("fail plainly when Google gives no access token", async () => {
    const network = fakeFetch([{ ...GOOGLE_TOKEN, json: {} }]);
    const api = adapterOf("google")({ fields: { clientId: "c", clientSecret: "s", refreshToken: "r" }, fetch: network.fetch, wait: async () => {} });
    await expect(api.days?.(ACME, "2026-11-01", "2026-11-05")).rejects.toThrow("Google gave no access token: allow access again.");
  });
});

describe("calls to a service", () => {
  const answered = (status: number, headers: Record<string, string> = {}, json: unknown = { message: "No" }) => new Response(JSON.stringify(json), { status, headers });

  it("are bounded in time, and a hung service gets no second try", async () => {
    let calls = 0;
    const hung = (async (_url: unknown, init: RequestInit) => {
      calls += 1;
      expect(init.signal).toBeInstanceOf(AbortSignal);
      throw Object.assign(new Error("Timed out"), { name: "TimeoutError" });
    }) as typeof fetch;
    await expect(withRetries(async () => {}, () => requestJson(hung, "Service", "https://service.example/?key=secret"))).rejects.toMatchObject({ status: 0, message: "Service didn’t answer in time." });
    expect(calls).toBe(1);
  });

  it("say nothing of what the network says, which can repeat the address and its key", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed for https://service.example/?key=secret");
    }) as unknown as typeof fetch;
    const failure = await requestJson(down, "Service", "https://service.example/?key=secret").catch((error: Error) => error);
    expect((failure as Error).message).toBe("Service couldn’t be reached.");
  });

  it("wait as long as a service asks, in seconds or as a date", async () => {
    const waits: number[] = [];
    const statuses = [answered(429, { "retry-after": "7" }), answered(429, { "retry-after": new Date(Date.now() + 20_000).toUTCString() }), answered(200, {}, { fine: true })];
    const answers = (async () => statuses.shift()) as unknown as typeof fetch;
    expect(await withRetries(async (ms) => void waits.push(ms), () => requestJson(answers, "Service", "https://service.example/"))).toEqual({ fine: true });
    expect(waits[0]).toBe(7_000);
    expect(waits[1]).toBeGreaterThan(15_000);
    expect(waits[1]).toBeLessThanOrEqual(20_000);
  });

  it("leave for the next run a service asking for longer than a minute", async () => {
    const waits: number[] = [];
    const answers = (async () => answered(429, { "retry-after": "3600" })) as unknown as typeof fetch;
    await expect(withRetries(async (ms) => void waits.push(ms), () => requestJson(answers, "Service", "https://service.example/"))).rejects.toMatchObject({ status: 429, retryAfterMs: 3_600_000 });
    expect(waits).toEqual([]);
  });

  it("wait longer each time when a service doesn't say how long, ignoring a date already past", async () => {
    const waits: number[] = [];
    const answers = (async () => answered(503, { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" })) as unknown as typeof fetch;
    await expect(withRetries(async (ms) => void waits.push(ms), () => requestJson(answers, "Service", "https://service.example/"))).rejects.toMatchObject({ status: 503 });
    expect(waits).toEqual([2_000, 4_000, 8_000]);
  });

  it("tell a quota from a refusal, whatever the status", () => {
    expect(isQuota(new ProviderError("Google", 403, "Search Analytics QPS quota exceeded"))).toBe(true);
    expect(isQuota(new ProviderError("Google", 403, "User Rate Limit Exceeded"))).toBe(true);
    expect(isQuota(new ProviderError("Bing", 400, "ERROR!!! ThrottleUser"))).toBe(true);
    expect(isQuota(new ProviderError("Google", 429, "Slow down"))).toBe(true);
    expect(isQuota(new ProviderError("Google", 403, "No access"))).toBe(false);
    expect(isRefusal(new ProviderError("Google", 403, "No access"))).toBe(true);
    expect(isRefusal(new ProviderError("Google", 401, "Ended"))).toBe(true);
    expect(isRefusal(new ProviderError("Google", 403, "Quota exceeded"))).toBe(false);
    expect(isRefusal(new ProviderError("Google", 500, "Down"))).toBe(false);
    expect(isRefusal(new Error("Ours"))).toBe(false);
  });
});

describe("Bing's key", () => {
  const BING_STATS = "GET https://ssl.bing.com/webmaster/api.svc/json/GetRankAndTrafficStats";

  it("is taken out of whatever Bing's answer repeats, plainly or as part of an address", async () => {
    const { workspaceId } = await onBing();
    const echoing = [{ match: BING_STATS, status: 400, json: { Message: "Bad call to /json/GetRankAndTrafficStats?apikey=a-bing-key&siteUrl=x, a-bing-key" } }];
    await read(echoing).report;
    const { lastSyncError } = await siteRow(workspaceId);
    expect(lastSyncError).toContain("Bad call");
    expect(lastSyncError).not.toContain("a-bing-key");
  });
});

describe("a failure on our own side", () => {
  it("isn't put on the service, and reaches the logs without any value", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { workspaceId } = await onGoogle();
    const saving = [...googleProperty(ACME, { totals: [{ keys: ["not a date"], clicks: 1, impressions: 2, position: 3 }] }), GOOGLE_TOKEN];
    expect(await read(saving).report).toEqual({ synced: 0, failed: 1, left: 0 });
    expect((await siteRow(workspaceId)).lastSyncError).toBe("Owlseen couldn’t finish this read, on its own side. It will try again.");
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0][0])).toContain("a query failed (22007)");
    expect(String(logged.mock.calls[0][0])).not.toContain("not a date");
    logged.mockRestore();
  });

  it("says something that isn't a query error by its kind alone", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    logFailure("Doing it", new TypeError("A value nobody should log"));
    logFailure("Doing it", "a string");
    expect(logged.mock.calls.map(([line]) => line)).toEqual(["Doing it: TypeError", "Doing it: something that isn't an error"]);
    logged.mockRestore();
  });
});

describe("a read that's stopped", () => {
  const QUERY = `POST https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(ACME)}/searchAnalytics/query`;
  const keywordRow = { keys: ["acme", "2026-11-01"], clicks: 1, impressions: 2, position: 3 };

  /** Time runs out once the first read has got this many calls in, with nothing left of the grace a read under way gets. */
  function outOfTimeAfter(calls: number, deadline: number) {
    let made = 0;
    const clock = { now: NOW.getTime() };
    const network = fakeFetch([{ match: QUERY, bodyHas: '"query","date"', json: { rows: [keywordRow] } }, ...googleProperty(ACME), GOOGLE_TOKEN]);
    const moving = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = await network.fetch(input, init);
      made += 1;
      if (made >= calls) clock.now = deadline + 60_000;
      return answer;
    }) as typeof fetch;
    const services: Services = { db, settings: testSettings, fetch: moving, now: () => new Date(clock.now), wait: async () => {} };
    return { services, calls: network.calls };
  }

  it("says it didn't finish, keeps what it saved, and carries on from there", async () => {
    const { workspaceId } = await onGoogle();
    const deadline = NOW.getTime() + 60_000;
    expect(await syncDueSites(outOfTimeAfter(4, deadline).services, deadline)).toEqual({ synced: 0, failed: 0, left: 1 });
    const stopped = await siteRow(workspaceId);
    expect(stopped).toMatchObject({ lastSyncedAt: null, lastSyncError: "This read didn’t finish. It carries on at the next run.", lastReadFailed: true, googleReadAt: null });
    expect(stopped.keywordsReadThrough).toBeTruthy();
    const { report, calls } = read([{ match: QUERY, bodyHas: '"query","date"', json: { rows: [keywordRow] } }, ...googleProperty(ACME), GOOGLE_TOKEN]);
    expect(await report).toEqual({ synced: 1, failed: 0, left: 0 });
    const keywordReads = asked(calls).filter(([kind]) => kind === "query+date");
    expect(keywordReads[0][1] > (stopped.keywordsReadThrough as string)).toBe(true);
    expect(await siteRow(workspaceId)).toMatchObject({ lastSyncError: null, lastReadFailed: false, keywordsReadThrough: null, pagesReadThrough: null, googleReadAt: NOW });
  });

  it("gets a large property further each run, even if no run sees it through", async () => {
    const { workspaceId } = await onGoogle();
    const deadline = NOW.getTime() + 60_000;
    const through: (string | null)[] = [];
    for (let run = 0; run < 3; run += 1) {
      await syncDueSites(outOfTimeAfter(3, deadline).services, deadline);
      through.push((await siteRow(workspaceId)).keywordsReadThrough);
    }
    expect(through[0]).toBeTruthy();
    expect((through[1] as string) > (through[0] as string)).toBe(true);
    expect((through[2] as string) > (through[1] as string)).toBe(true);
  });
});

describe("a stretch that times out or fails", () => {
  function google(answer: (body: { startDate: string; endDate: string }) => Response | Error) {
    const asked: string[] = [];
    const fetchIt = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input.toString().includes("oauth2")) return Response.json({ access_token: "token" });
      const body = JSON.parse(String(init?.body)) as { startDate: string; endDate: string };
      asked.push(`${body.startDate} ${body.endDate}`);
      const answered = answer(body);
      if (answered instanceof Error) throw answered;
      return answered;
    }) as typeof fetch;
    const client = adapterOf("google")({ fields: { clientId: "c", clientSecret: "s", refreshToken: "r" }, fetch: fetchIt, wait: async () => {} }) as unknown as KeywordsAndPages;
    return { client, asked };
  }
  const timedOut = () => Object.assign(new Error("Timed out"), { name: "TimeoutError" });

  it("is read in shorter ones, down to single days", async () => {
    const { client, asked } = google(({ startDate, endDate }) => (startDate === endDate ? Response.json({ rows: [{ keys: ["acme", startDate], clicks: 1, impressions: 1, position: 1 }] }) : timedOut()));
    const days: string[] = [];
    for await (const slice of client.keywordSlices(ACME, "2026-11-01", "2026-11-04")) days.push(...slice.days.map(({ day }) => day));
    expect(days).toEqual(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"]);
    expect(asked[0]).toBe("2026-11-01 2026-11-04");
  });

  it("gives up on a single day that still fails, saying so, and doesn't try for a refusal", async () => {
    const down = google(() => timedOut());
    const reading = (async () => {
      for await (const slice of down.client.keywordSlices(ACME, "2026-11-01", "2026-11-02")) expect(slice).toBeUndefined();
    })();
    await expect(reading).rejects.toMatchObject({ status: 0, message: "Google didn’t answer in time." });
    const refused = google(() => Response.json({ error: { message: "No access" } }, { status: 403 }));
    const refusing = (async () => {
      for await (const slice of refused.client.keywordSlices(ACME, "2026-11-01", "2026-11-04")) expect(slice).toBeUndefined();
    })();
    await expect(refusing).rejects.toMatchObject({ status: 403 });
    expect(refused.asked).toHaveLength(1);
  });
});

describe("whose turn it is", () => {
  it("keeps a share of a short run for sites that have been failing, however many others wait", async () => {
    await db.delete(site);
    const seat = await createTestWorkspace(db);
    await connectGoogle(testServices(db).services, seat.workspaceId, seat.userId);
    const names = Array.from({ length: 30 }, (_, index) => `fine${String(index).padStart(2, "0")}.example`);
    for (const name of names) await followSite(db, seat.workspaceId, name);
    const failing = await followSite(db, seat.workspaceId, "failing.example");
    await withWorkspace(db, seat.workspaceId, (tx) => tx.update(site).set({ lastReadFailed: true, lastSyncError: "Google is down." }).where(eq(site.id, failing.id)));
    const clock = { now: NOW.getTime() };
    // A call a second, and 16 calls for a first read, four at once: 30 sites would take 480 seconds.
    const deadline = NOW.getTime() + 230_000;
    const network = fakeFetch([GOOGLE_TOKEN, { match: "POST https://www.googleapis.com/webmasters/v3/sites", json: { rows: [] } }, { match: "GET https://www.googleapis.com/webmasters/v3/sites", json: {} }]);
    const moving = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = await network.fetch(input, init);
      clock.now += 1_000;
      return answer;
    }) as typeof fetch;
    await syncDueSites({ db, settings: testSettings, fetch: moving, now: () => new Date(clock.now), wait: async () => {} }, deadline);
    const order = [...new Set(network.calls.filter(({ url }) => url.includes("/sites/")).map(({ url }) => decodeURIComponent(url.split("/sites/")[1].split("/")[0])))];
    // Fine ones first, as many as fit before its share of the time; not all of them fit.
    expect(order.slice(0, 4).every((name) => name.startsWith("sc-domain:fine"))).toBe(true);
    expect(order).toContain("sc-domain:failing.example");
    expect((await sitesOf(db, seat.workspaceId)).filter(({ lastSyncedAt }) => lastSyncedAt === null).length).toBeGreaterThan(0);
  });

  it("puts sites first when their account is connected again, what they said cleared", async () => {
    const seat = await createTestWorkspace(db);
    const { services } = testServices(db);
    await connectBing(services, seat.workspaceId, seat.userId);
    const stuck = await followSite(db, seat.workspaceId, "stuck.example", { googleProperty: null, bingSite: "https://stuck.example/" });
    const fine = await followSite(db, seat.workspaceId, "fine.example", { googleProperty: null, bingSite: "https://fine.example/" });
    const read = new Date("2026-11-04T09:00:00Z");
    await withWorkspace(db, seat.workspaceId, (tx) => tx.update(site).set({ lastSyncedAt: read, lastSyncError: "Bing refused this key.", lastReadFailed: true }).where(eq(site.id, stuck.id)));
    await withWorkspace(db, seat.workspaceId, (tx) => tx.update(site).set({ lastSyncedAt: read }).where(eq(site.id, fine.id)));
    await connectWithFields(testServices(db).services, seat.workspaceId, seat.userId, "bing", { apiKey: "another-key" });
    const rows = await sitesOf(db, seat.workspaceId);
    expect(rows.find(({ id }) => id === stuck.id)).toMatchObject({ lastSyncError: null, lastReadFailed: false, lastSyncedAt: null });
    expect(rows.find(({ id }) => id === fine.id)).toMatchObject({ lastSyncedAt: read });
  });
});

describe("a run's budget", () => {
  it("doesn't wait past it for a service asking to be left alone, and leaves the rest for the next run", async () => {
    await db.delete(site);
    const { workspaceId } = await onGoogle();
    const clock = { now: NOW.getTime() };
    const limited = fakeFetch([GOOGLE_TOKEN, { match: "POST https://www.googleapis.com/webmasters/v3/sites", status: 429, json: { error: { message: "Quota exceeded" } }, headers: { "retry-after": "50" } }]);
    const report = await syncDueSites({ db, settings: testSettings, fetch: limited.fetch, now: () => new Date(clock.now), wait: async (ms) => void (clock.now += ms) }, NOW.getTime() + 70_000);
    expect(report).toEqual({ synced: 0, failed: 0, left: 1 });
    expect(clock.now - NOW.getTime()).toBeLessThanOrEqual(70_000);
    expect((await siteRow(workspaceId)).lastReadFailed).toBe(true);
  });
});
