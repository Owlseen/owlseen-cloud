import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { alertsOf } from "@/application/alerts";
import { keywordsOf, movedKeywordsOf, opportunitiesOf } from "@/application/keywords";
import { overviewOf } from "@/application/overview";
import { decayingPagesOf, pagesOf } from "@/application/pages";
import { mostClicked, trackedKeywordsOf, trackKeyword, untrackKeyword } from "@/application/rank-tracker";
import { siteCardsOf } from "@/application/site-cards";
import { boundedDays, periodBefore, periodEndingAt } from "@/application/time-range";
import type { Database } from "@/infrastructure/db/client";
import { keyword, keywordDay, site } from "@/infrastructure/db/schema/search";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { followSite, NOW, storeKeyword, storePage, storeTotals } from "./support/search";

// With NOW on 5 November: a week is 30 October to 5 November, and the one before starts on 23 October.
const WEEK = periodEndingAt(NOW, 7);
const THREE_DAYS = periodEndingAt(NOW, 3);

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
});

async function seat(name = "acme.example") {
  const { workspaceId, userId } = await createTestWorkspace(db);
  return { workspaceId, userId, site: await followSite(db, workspaceId, name) };
}

const day = (date: string, clicks: number, impressions: number, position = 5) => ({ day: date, clicks, impressions, position });

describe("a period", () => {
  it("is whole UTC days ending today, however late it is", () => {
    expect(WEEK).toEqual({ from: "2026-10-30", to: "2026-11-05", days: ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"], lastWholeDay: "2026-11-04" });
    expect(periodEndingAt(new Date("2026-11-05T23:59:59Z"), 1).days).toEqual(["2026-11-05"]);
  });

  it("has the same length of time just before it", () => {
    expect(periodBefore(WEEK)).toEqual({ from: "2026-10-23", to: "2026-10-29" });
  });

  it.each([
    [7, 7],
    ["7", 7],
    [2.9, 2],
    [-3, 1],
    [1000, 365],
    [0, 28],
    ["many", 28],
    [undefined, 28],
    [null, 28],
  ])("takes %j to mean %d days", (asked, days) => {
    expect(boundedDays(asked)).toBe(days);
  });
});

describe("an overview", () => {
  /** A site with two engines in the period, a day before it, and one too old to count. */
  async function stocked() {
    const mine = await seat();
    await storeTotals(db, mine.workspaceId, mine.site.id, "google", [day("2026-11-01", 10, 100, 2), day("2026-11-03", 5, 300, 8), day("2026-10-25", 4, 50, 16), day("2026-10-01", 1000, 1000, 1)]);
    await storeTotals(db, mine.workspaceId, mine.site.id, "bing", [{ day: "2026-11-03", clicks: 2, impressions: 100, position: null }]);
    return mine;
  }
  const query = (siteId: string | null, engine?: "google" | "bing") => ({ sites: siteId, period: WEEK, engine });

  it("adds up the period, weighing position by what had one", async () => {
    const { workspaceId, site: { id } } = await stocked();
    const { totals, from, to, dayNote } = await overviewOf(db, workspaceId, query(id));
    // Position: (2 × 100 + 8 × 300) / 400 = 6.5, Bing's 100 impressions saying nothing of it.
    expect(totals).toEqual({ clicks: 17, impressions: 500, position: 6.5 });
    expect({ from, to }).toEqual({ from: "2026-10-30", to: "2026-11-05" });
    expect(dayNote).toContain("Pacific time");
  });

  it("compares with the same length of time just before", async () => {
    const { workspaceId, site: { id } } = await stocked();
    expect((await overviewOf(db, workspaceId, query(id))).totalsBefore).toEqual({ clicks: 4, impressions: 50, position: 16 });
  });

  it("gives every day of the period, a quiet one as zeros", async () => {
    const { workspaceId, site: { id } } = await stocked();
    const quiet = (date: string) => ({ date, clicks: 0, impressions: 0, position: null });
    expect((await overviewOf(db, workspaceId, query(id))).days).toEqual([quiet("2026-10-30"), quiet("2026-10-31"), { date: "2026-11-01", clicks: 10, impressions: 100, position: 2 }, quiet("2026-11-02"), { date: "2026-11-03", clicks: 7, impressions: 400, position: 8 }, quiet("2026-11-04"), quiet("2026-11-05")]);
  });

  it("gives each engine's share", async () => {
    const { workspaceId, site: { id } } = await stocked();
    expect((await overviewOf(db, workspaceId, query(id))).engines).toEqual([
      { engine: "bing", clicks: 2, impressions: 100, position: null },
      { engine: "google", clicks: 15, impressions: 400, position: 6.5 },
    ]);
  });

  it("can be one engine's, still showing both shares", async () => {
    const { workspaceId, site: { id } } = await stocked();
    const { totals, days, engines, totalsBefore } = await overviewOf(db, workspaceId, query(id, "bing"));
    expect(totals).toEqual({ clicks: 2, impressions: 100, position: null });
    expect(totalsBefore).toEqual({ clicks: 0, impressions: 0, position: null });
    expect(days.find(({ date }) => date === "2026-11-03")).toEqual({ date: "2026-11-03", clicks: 2, impressions: 100, position: null });
    expect(engines).toHaveLength(2);
  });

  it("can be a whole workspace's, and only that one's", async () => {
    const mine = await stocked();
    const other = await followSite(db, mine.workspaceId, "northwind.example");
    await storeTotals(db, mine.workspaceId, other.id, "google", [day("2026-11-01", 1, 100, 4)]);
    const stranger = await seat("third.example");
    await storeTotals(db, stranger.workspaceId, stranger.site.id, "google", [day("2026-11-01", 500, 500, 1)]);
    // Position: (2 × 100 + 8 × 300 + 4 × 100) / 500 = 6.
    expect((await overviewOf(db, mine.workspaceId, query(null))).totals).toEqual({ clicks: 18, impressions: 600, position: 6 });
    expect((await overviewOf(db, mine.workspaceId, query(other.id))).totals).toEqual({ clicks: 1, impressions: 100, position: 4 });
    expect((await overviewOf(db, mine.workspaceId, query(stranger.site.id))).totals).toEqual({ clicks: 0, impressions: 0, position: null });
  });

  it("says when a site here was last read, the latest of them for a workspace", async () => {
    const mine = await seat();
    expect((await overviewOf(db, mine.workspaceId, query(mine.site.id))).lastSyncedAt).toBeNull();
    const other = await followSite(db, mine.workspaceId, "northwind.example");
    await withWorkspace(db, mine.workspaceId, (tx) => tx.update(site).set({ lastSyncedAt: new Date("2026-11-04T06:00:00Z") }));
    await withWorkspace(db, mine.workspaceId, (tx) => tx.update(site).set({ lastSyncedAt: new Date("2026-11-05T06:00:00Z") }).where(eq(site.id, other.id)));
    expect((await overviewOf(db, mine.workspaceId, query(mine.site.id))).lastSyncedAt).toEqual(new Date("2026-11-04T06:00:00Z"));
    expect((await overviewOf(db, mine.workspaceId, query(null))).lastSyncedAt).toEqual(new Date("2026-11-05T06:00:00Z"));
  });

  it("is all zeros and no position with nothing stored", async () => {
    const { workspaceId } = await seat();
    const { totals, totalsBefore, days, engines } = await overviewOf(db, workspaceId, query(null));
    expect(totals).toEqual({ clicks: 0, impressions: 0, position: null });
    expect(totalsBefore).toEqual({ clicks: 0, impressions: 0, position: null });
    expect(days.every(({ clicks, position }) => clicks === 0 && position === null)).toBe(true);
    expect(engines).toEqual([]);
  });
});

describe("keywords", () => {
  const texts = (rows: { text: string }[]) => rows.map(({ text }) => text);
  const search = (workspaceId: string, words: string) => keywordsOf(db, workspaceId, { sites: null, period: WEEK, search: words });

  it("are added up over the period, position weighted, on the keyword's site", async () => {
    const { workspaceId, site: { id, name } } = await seat();
    const keywordId = await storeKeyword(db, workspaceId, id, "acme pricing", [day("2026-11-01", 1, 100, 2), day("2026-11-03", 2, 300, 8), day("2026-10-29", 50, 500, 1)]);
    expect(await keywordsOf(db, workspaceId, { sites: id, period: WEEK })).toEqual([{ id: keywordId, text: "acme pricing", siteId: id, siteName: name, clicks: 3, impressions: 400, position: 6.5 }]);
  });

  it("come the most clicked first, then the most shown, then by name", async () => {
    const { workspaceId, site: { id } } = await seat();
    await storeKeyword(db, workspaceId, id, "few", [day("2026-11-01", 1, 10)]);
    await storeKeyword(db, workspaceId, id, "many", [day("2026-11-01", 9, 10)]);
    await storeKeyword(db, workspaceId, id, "same and shown", [day("2026-11-01", 3, 90)]);
    await storeKeyword(db, workspaceId, id, "same b", [day("2026-11-01", 3, 10)]);
    await storeKeyword(db, workspaceId, id, "same a", [day("2026-11-01", 3, 10)]);
    expect(texts(await keywordsOf(db, workspaceId, { sites: id, period: WEEK }))).toEqual(["many", "same and shown", "same a", "same b", "few"]);
    expect(texts(await keywordsOf(db, workspaceId, { sites: id, period: WEEK, limit: 2 }))).toEqual(["many", "same and shown"]);
  });

  it("are found by part of the words, whatever the capitals", async () => {
    const { workspaceId, site: { id } } = await seat();
    await storeKeyword(db, workspaceId, id, "acme pricing", [day("2026-11-01", 1, 10)]);
    await storeKeyword(db, workspaceId, id, "acme login", [day("2026-11-01", 1, 10)]);
    expect(texts(await search(workspaceId, "PRIC"))).toEqual(["acme pricing"]);
    expect(texts(await search(workspaceId, "nothing like it"))).toEqual([]);
  });

  it.each([
    ["%", ["100% free"]],
    ["_", ["a_b test"]],
    ["\\", ["back\\slash"]],
    ["a_b", ["a_b test"]],
    ["0%", ["100% free"]],
  ])("take %j literally when searching", async (words, found) => {
    const { workspaceId, site: { id } } = await seat();
    for (const text of ["100% free", "a_b test", "axb test", "back\\slash", "plain"]) await storeKeyword(db, workspaceId, id, text, [day("2026-11-01", 1, 10)]);
    expect(texts(await search(workspaceId, words))).toEqual(found);
  });

  it("stay on their site, and in their workspace", async () => {
    const mine = await seat();
    const other = await followSite(db, mine.workspaceId, "northwind.example");
    const stranger = await seat("third.example");
    await storeKeyword(db, mine.workspaceId, mine.site.id, "same words", [day("2026-11-01", 1, 10)]);
    await storeKeyword(db, mine.workspaceId, other.id, "same words", [day("2026-11-01", 2, 10)]);
    await storeKeyword(db, stranger.workspaceId, stranger.site.id, "theirs", [day("2026-11-01", 3, 10)]);
    expect((await keywordsOf(db, mine.workspaceId, { sites: null, period: WEEK })).map(({ siteName, clicks }) => [siteName, clicks])).toEqual([["northwind.example", 2], ["acme.example", 1]]);
    expect(await keywordsOf(db, mine.workspaceId, { sites: stranger.site.id, period: WEEK })).toEqual([]);
  });
});

describe("opportunities", () => {
  /** Each of these, one day of its figures: 10% of impressions is what position 3 would bring. */
  const CASES: [string, number, number, number][] = [
    ["striking", 30, 1000, 8],
    ["wide", 80, 1500, 6],
    ["biggest", 50, 2000, 15],
    ["already there", 5, 1000, 2],
    ["too rare", 0, 19, 8],
    ["too far", 0, 5000, 21],
  ];

  async function stocked() {
    const mine = await seat();
    for (const [text, clicks, impressions, position] of CASES) await storeKeyword(db, mine.workspaceId, mine.site.id, text, [day("2026-11-01", clicks, impressions, position)]);
    return mine;
  }

  it("are those in reach, the most clicks to win first, then the most shown", async () => {
    const { workspaceId, site: { id } } = await stocked();
    const found = await opportunitiesOf(db, workspaceId, { sites: id, period: WEEK });
    // 200 − 50 = 150; 150 − 80 = 70; 100 − 30 = 70, shown less.
    expect(found.map(({ text, potential, position }) => [text, potential, position])).toEqual([["biggest", 150, 15], ["wide", 70, 6], ["striking", 70, 8]]);
    expect(found[0]).toMatchObject({ siteName: "acme.example", clicks: 50, impressions: 2000 });
  });

  it("stop at the limit asked for", async () => {
    const { workspaceId } = await stocked();
    expect((await opportunitiesOf(db, workspaceId, { sites: null, period: WEEK, limit: 1 })).map(({ text }) => text)).toEqual(["biggest"]);
  });

  it("are judged on the whole period: a good day doesn't make a keyword top, nor a bad one far", async () => {
    const { workspaceId, site: { id } } = await seat();
    // (1 × 100 + 9 × 300) / 400 = 7, which is in reach whatever either day says.
    await storeKeyword(db, workspaceId, id, "moved", [day("2026-11-01", 0, 100, 1), day("2026-11-02", 0, 300, 9)]);
    expect(await opportunitiesOf(db, workspaceId, { sites: id, period: WEEK })).toMatchObject([{ text: "moved", position: 7, potential: 40 }]);
  });
});

describe("pages", () => {
  it("are added up over the period, the most clicked first, up to the limit", async () => {
    const { workspaceId, site: { id, name } } = await seat();
    await storePage(db, workspaceId, id, "https://acme.example/pricing", [day("2026-11-01", 1, 100, 2), day("2026-11-03", 2, 300, 8), day("2026-10-29", 50, 500, 1)]);
    await storePage(db, workspaceId, id, "https://acme.example/", [day("2026-11-01", 9, 10, 1)]);
    expect(await pagesOf(db, workspaceId, { sites: id, period: WEEK })).toEqual([
      { url: "https://acme.example/", siteId: id, siteName: name, clicks: 9, impressions: 10, position: 1 },
      { url: "https://acme.example/pricing", siteId: id, siteName: name, clicks: 3, impressions: 400, position: 6.5 },
    ]);
    expect((await pagesOf(db, workspaceId, { sites: id, period: WEEK, limit: 1 })).map(({ url }) => url)).toEqual(["https://acme.example/"]);
  });

  it("stay in their workspace", async () => {
    const mine = await seat();
    const stranger = await seat("third.example");
    await storePage(db, stranger.workspaceId, stranger.site.id, "https://third.example/", [day("2026-11-01", 1, 10)]);
    expect(await pagesOf(db, mine.workspaceId, { sites: null, period: WEEK })).toEqual([]);
    expect(await pagesOf(db, mine.workspaceId, { sites: stranger.site.id, period: WEEK })).toEqual([]);
  });
});

describe("pages losing their traffic", () => {
  // With NOW on 5 November, four weeks up to yesterday start on 8 October, and the four before start on 10 September.
  const LAST_DAY_BEFORE = "2026-10-07";
  const FIRST_DAY_BEFORE = "2026-09-10";
  const FIRST_DAY_RECENT = "2026-10-08";
  const LAST_DAY_RECENT = "2026-11-04";

  it("compare four weeks with the four before, each day in one and only one", async () => {
    const { workspaceId, site: { id, name } } = await seat();
    await storePage(db, workspaceId, id, "https://acme.example/half", [day(LAST_DAY_BEFORE, 60, 100), day(FIRST_DAY_BEFORE, 40, 100), day(FIRST_DAY_RECENT, 20, 100), day(LAST_DAY_RECENT, 30, 100)]);
    expect(await decayingPagesOf(db, workspaceId, id, NOW)).toEqual([{ url: "https://acme.example/half", siteId: id, siteName: name, clicks: 50, clicksBefore: 100, lost: 50, shareLost: 0.5 }]);
  });

  it("don't count clicks from before those eight weeks, or from today, still filling in", async () => {
    const { workspaceId, site: { id } } = await seat();
    await storePage(db, workspaceId, id, "https://acme.example/old", [day("2026-09-09", 1000, 1000)]);
    await storePage(db, workspaceId, id, "https://acme.example/today", [day(FIRST_DAY_BEFORE, 100, 100), day(LAST_DAY_RECENT, 50, 100), day("2026-11-05", 500, 500)]);
    expect((await decayingPagesOf(db, workspaceId, id, NOW)).map(({ url, clicks, clicksBefore }) => [url, clicks, clicksBefore])).toEqual([["https://acme.example/today", 50, 100]]);
  });

  it("aren't those holding level over two full periods of the same length", async () => {
    const { workspaceId, site: { id } } = await seat();
    // Ten clicks every day for 56 days comes to 280 and 280, however the days fall.
    const everyDay = Array.from({ length: 58 }, (_, index) => day(new Date(NOW.getTime() - index * 86_400_000).toISOString().slice(0, 10), 10, 100));
    await storePage(db, workspaceId, id, "https://acme.example/steady", everyDay);
    await storePage(db, workspaceId, id, "https://acme.example/fell", [...everyDay.filter(({ day: date }) => date < FIRST_DAY_RECENT), ...everyDay.filter(({ day: date }) => date >= FIRST_DAY_RECENT).map((row) => ({ ...row, clicks: 7 }))]);
    // 280 down to 196 is exactly 30%.
    expect((await decayingPagesOf(db, workspaceId, id, NOW)).map(({ url, clicks, clicksBefore, shareLost }) => [url, clicks, clicksBefore, shareLost])).toEqual([["https://acme.example/fell", 196, 280, 0.3]]);
  });

  it("put the biggest loss first, then by address, leaving out what's too small or held up", async () => {
    const { workspaceId, site: { id } } = await seat();
    const fell = (url: string, before: number, recent: number) => storePage(db, workspaceId, id, `https://acme.example/${url}`, [day(LAST_DAY_BEFORE, before, 100), day(LAST_DAY_RECENT, recent, 100)]);
    await fell("small", 20, 14);
    await fell("big", 100, 10);
    await fell("tie-b", 100, 50);
    await fell("tie-a", 100, 50);
    await fell("too-few", 9, 0);
    await fell("held", 100, 71);
    expect((await decayingPagesOf(db, workspaceId, null, NOW)).map(({ url, lost }) => [url.split("/").at(-1), lost])).toEqual([["big", 90], ["tie-a", 50], ["tie-b", 50], ["small", 6]]);
  });

  it("show 50 at most", async () => {
    const { workspaceId, site: { id } } = await seat();
    for (let index = 0; index < 51; index += 1) await storePage(db, workspaceId, id, `https://acme.example/${index}`, [day(LAST_DAY_BEFORE, 100 + index, 100)]);
    await storePage(db, workspaceId, id, "https://acme.example/reported", [day(LAST_DAY_RECENT, 1, 100)]);
    const found = await decayingPagesOf(db, workspaceId, id, NOW);
    expect(found).toHaveLength(50);
    expect(found[0].lost).toBe(150);
  });
});

describe("site cards", () => {
  // Three days: 3 to 5 November, against 31 October to 2 November.
  it("say how a site did, with a spark for each day of the period", async () => {
    const { workspaceId, site: { id } } = await seat();
    await storeTotals(db, workspaceId, id, "google", [day("2026-11-03", 1, 10, 3), day("2026-11-05", 3, 30, 5), day("2026-11-01", 2, 20, 9), day("2026-10-30", 500, 500, 1)]);
    await withWorkspace(db, workspaceId, (tx) => tx.update(site).set({ lastSyncedAt: NOW, lastSyncError: "Google refused access." }));
    // Position: (3 × 10 + 5 × 30) / 40 = 4.5.
    expect(await siteCardsOf(db, workspaceId, THREE_DAYS)).toEqual([{ siteId: id, name: "acme.example", clicks: 4, impressions: 40, position: 4.5, clicksBefore: 2, lastSyncedAt: NOW, lastSyncError: "Google refused access.", spark: [1, 0, 3], keywords: 0, tracked: 0, bands: { "1-3": 0, "4-10": 0, "11-20": 0, "21+": 0 } }]);
  });

  it("add both engines up, the spark included", async () => {
    const { workspaceId, site: { id } } = await seat();
    await storeTotals(db, workspaceId, id, "google", [day("2026-11-05", 3, 30, 5)]);
    await storeTotals(db, workspaceId, id, "bing", [{ day: "2026-11-05", clicks: 2, impressions: 20, position: null }, { day: "2026-11-01", clicks: 7, impressions: 70, position: null }]);
    expect(await siteCardsOf(db, workspaceId, THREE_DAYS)).toMatchObject([{ clicks: 5, impressions: 50, position: 5, clicksBefore: 7, spark: [0, 0, 5] }]);
  });

  it("say the same position as the overview, when only one engine gives one", async () => {
    const { workspaceId, site: { id } } = await seat();
    await storeTotals(db, workspaceId, id, "google", [day("2026-11-03", 1, 100, 2), day("2026-11-04", 1, 100, 10)]);
    await storeTotals(db, workspaceId, id, "bing", [{ day: "2026-11-03", clicks: 9, impressions: 900, position: null }]);
    // Google alone says where the site ranks: (2 × 100 + 10 × 100) / 200 = 6, whatever Bing showed on the first day.
    const [card] = await siteCardsOf(db, workspaceId, THREE_DAYS);
    const { totals } = await overviewOf(db, workspaceId, { sites: id, period: THREE_DAYS });
    expect(totals.position).toBe(6);
    expect(card.position).toBe(6);
  });

  it("count keywords per rank band, on their position over the period", async () => {
    const { workspaceId, site: { id } } = await seat();
    await storeKeyword(db, workspaceId, id, "at three", [day("2026-11-03", 1, 10, 3)]);
    await storeKeyword(db, workspaceId, id, "top", [day("2026-11-03", 1, 10, 1)]);
    // (3 × 10 + 4 × 10) / 20 = 3.5, which is past the first band though one day was in it.
    await storeKeyword(db, workspaceId, id, "just past", [day("2026-11-03", 1, 10, 3), day("2026-11-04", 1, 10, 4)]);
    await storeKeyword(db, workspaceId, id, "second page", [day("2026-11-03", 1, 10, 20)]);
    await storeKeyword(db, workspaceId, id, "far", [day("2026-11-03", 1, 10, 21)]);
    await storeKeyword(db, workspaceId, id, "not shown", [day("2026-11-03", 0, 0, 0)]);
    await storeKeyword(db, workspaceId, id, "too old", [day("2026-11-01", 1, 10, 1)]);
    expect(await siteCardsOf(db, workspaceId, THREE_DAYS)).toMatchObject([{ keywords: 6, bands: { "1-3": 2, "4-10": 1, "11-20": 1, "21+": 1 } }]);
  });

  it("count what's followed", async () => {
    const { workspaceId, site: { id } } = await seat();
    await trackKeyword(db, workspaceId, id, "one");
    await trackKeyword(db, workspaceId, id, "two");
    expect(await siteCardsOf(db, workspaceId, THREE_DAYS)).toMatchObject([{ tracked: 2 }]);
  });

  it("come the most clicked first, then by name, each with only its own", async () => {
    const { workspaceId, site: { id } } = await seat("beta.example");
    const alpha = await followSite(db, workspaceId, "alpha.example");
    const most = await followSite(db, workspaceId, "most.example");
    await storeTotals(db, workspaceId, most.id, "google", [day("2026-11-05", 9, 90)]);
    await storeKeyword(db, workspaceId, id, "beta's", [day("2026-11-05", 1, 10, 2)]);
    const cards = await siteCardsOf(db, workspaceId, THREE_DAYS);
    expect(cards.map(({ name, clicks, keywords, spark, position }) => [name, clicks, keywords, spark, position])).toEqual([["most.example", 9, 0, [0, 0, 9], 5], ["alpha.example", 0, 0, [0, 0, 0], null], ["beta.example", 0, 1, [0, 0, 0], null]]);
    expect(cards.map(({ siteId }) => siteId)).toEqual([most.id, alpha.id, id]);
  });

  it("stay in their workspace", async () => {
    const mine = await seat();
    const stranger = await seat("third.example");
    await storeTotals(db, stranger.workspaceId, stranger.site.id, "google", [day("2026-11-05", 9, 90)]);
    expect((await siteCardsOf(db, mine.workspaceId, THREE_DAYS)).map(({ name, clicks }) => [name, clicks])).toEqual([["acme.example", 0]]);
  });
});

describe("what moved this week", () => {
  // With NOW on 5 November: the last seven days up to yesterday start on 29 October, and the seven before on 22 October.
  const WEEK_STARTS = "2026-10-29";
  const WEEK_ENDS = "2026-11-04";
  const WEEK_BEFORE_STARTS = "2026-10-22";
  const WEEK_BEFORE_ENDS = "2026-10-28";

  /** A site whose clicks went from one week to the next. */
  async function moved(workspaceId: string, name: string, before: number, now: number) {
    const row = await followSite(db, workspaceId, name);
    await storeTotals(db, workspaceId, row.id, "google", [day(WEEK_BEFORE_ENDS, before, 100), day(WEEK_ENDS, now, 100)]);
    return row;
  }

  it("is what's falling hardest first, then what's up", async () => {
    const { workspaceId } = await createTestWorkspace(db);
    await moved(workspaceId, "up.example", 10, 20);
    await moved(workspaceId, "down-a-bit.example", 100, 70);
    await moved(workspaceId, "down-half.example", 100, 50);
    await moved(workspaceId, "down-most.example", 100, 20);
    await moved(workspaceId, "flat.example", 100, 100);
    await moved(workspaceId, "too-small.example", 9, 0);
    expect((await alertsOf(db, workspaceId, null, NOW)).map(({ siteName, severity, change }) => [siteName, severity, change])).toEqual([
      ["down-most.example", "high", -0.8],
      ["down-half.example", "high", -0.5],
      ["down-a-bit.example", "medium", -0.3],
      ["up.example", "info", 1],
    ]);
  });

  it("names the site and the clicks either side", async () => {
    const { workspaceId } = await createTestWorkspace(db);
    const row = await moved(workspaceId, "acme.example", 100, 50);
    expect(await alertsOf(db, workspaceId, row.id, NOW)).toEqual([{ siteId: row.id, siteName: "acme.example", severity: "high", change: -0.5, clicks: 50, clicksBefore: 100 }]);
  });

  it("compares two weeks of seven days, each day in one and only one", async () => {
    const { site: { id }, workspaceId } = await seat();
    await storeTotals(db, workspaceId, id, "google", [day(WEEK_BEFORE_STARTS, 40, 100), day(WEEK_BEFORE_ENDS, 60, 100), day(WEEK_STARTS, 20, 100), day(WEEK_ENDS, 30, 100)]);
    expect(await alertsOf(db, workspaceId, id, NOW)).toMatchObject([{ clicks: 50, clicksBefore: 100, change: -0.5 }]);
  });

  it("doesn't count the day before those two weeks, or today, still filling in", async () => {
    const { site: { id }, workspaceId } = await seat();
    await storeTotals(db, workspaceId, id, "google", [day("2026-10-21", 1000, 1000), day(WEEK_BEFORE_ENDS, 100, 100), day(WEEK_ENDS, 50, 100), day("2026-11-05", 500, 500)]);
    expect(await alertsOf(db, workspaceId, id, NOW)).toMatchObject([{ clicks: 50, clicksBefore: 100 }]);
  });

  it("says nothing of a site holding level, every day the same", async () => {
    const { site: { id }, workspaceId } = await seat();
    await storeTotals(db, workspaceId, id, "google", Array.from({ length: 16 }, (_, index) => day(new Date(NOW.getTime() - index * 86_400_000).toISOString().slice(0, 10), 100, 100)));
    expect(await alertsOf(db, workspaceId, id, NOW)).toEqual([]);
  });

  it("sees a fall of 30% from one week to the next, day after day", async () => {
    const { site: { id }, workspaceId } = await seat();
    const daysFrom = (first: string, count: number, clicks: number) => Array.from({ length: count }, (_, index) => day(new Date(Date.parse(`${first}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10), clicks, 100));
    await storeTotals(db, workspaceId, id, "google", [...daysFrom(WEEK_BEFORE_STARTS, 7, 100), ...daysFrom(WEEK_STARTS, 7, 70)]);
    expect(await alertsOf(db, workspaceId, id, NOW)).toMatchObject([{ severity: "medium", clicks: 490, clicksBefore: 700, change: -0.3 }]);
  });

  it("stays in its workspace", async () => {
    const { workspaceId } = await createTestWorkspace(db);
    const stranger = await createTestWorkspace(db, "Theirs");
    const theirs = await moved(stranger.workspaceId, "third.example", 100, 10);
    expect(await alertsOf(db, workspaceId, null, NOW)).toEqual([]);
    expect(await alertsOf(db, workspaceId, theirs.id, NOW)).toEqual([]);
  });
});

describe("days the engines haven't reported yet", () => {
  // With NOW on 5 November, a week is 30 October to 5 November and the one before starts on 23 October.
  const steady = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => day(new Date(Date.UTC(2026, 9, from + index)).toISOString().slice(0, 10), 10, 100));

  it("count on neither side of an overview", async () => {
    const { workspaceId, site: { id } } = await seat();
    // Steady at 10 a day, reported up to 3 November (the 34th): 5 of the week's 7 days.
    await storeTotals(db, workspaceId, id, "google", steady(16, 34));
    const { totals, totalsBefore } = await overviewOf(db, workspaceId, { sites: id, period: WEEK });
    expect(totals.clicks).toBe(50);
    expect(totalsBefore.clicks).toBe(50);
  });

  it("are cut per engine, as they don't report at the same pace", async () => {
    const { workspaceId, site: { id } } = await seat();
    await storeTotals(db, workspaceId, id, "google", steady(16, 33));
    await storeTotals(db, workspaceId, id, "bing", steady(16, 35));
    const { totals, totalsBefore } = await overviewOf(db, workspaceId, { sites: id, period: WEEK });
    expect(totals.clicks).toBe(40 + 60);
    expect(totalsBefore.clicks).toBe(40 + 60);
  });

  it("don't raise an alert about a steady site", async () => {
    const { workspaceId, site: { id } } = await seat();
    await storeTotals(db, workspaceId, id, "google", steady(16, 33));
    expect(await alertsOf(db, workspaceId, id, NOW)).toEqual([]);
  });

  it("don't hide a real fall in what has been reported", async () => {
    const { workspaceId, site: { id } } = await seat();
    await storeTotals(db, workspaceId, id, "google", [...steady(16, 28), day("2026-11-02", 1, 100), day("2026-11-01", 1, 100), day("2026-10-30", 1, 100)]);
    expect(await alertsOf(db, workspaceId, id, NOW)).toMatchObject([{ severity: "high", clicks: 3 }]);
  });

  it("don't count against a site's card", async () => {
    const { workspaceId, site: { id } } = await seat();
    await storeTotals(db, workspaceId, id, "google", steady(16, 34));
    expect((await siteCardsOf(db, workspaceId, WEEK, id))[0]).toMatchObject({ clicks: 50, clicksBefore: 50 });
  });

  it("don't make a steady keyword look as if it moved", async () => {
    const { workspaceId, site: { id } } = await seat();
    await storeKeyword(db, workspaceId, id, "steady", steady(16, 33));
    expect(await movedKeywordsOf(db, workspaceId, { sites: id, period: WEEK })).toEqual([]);
  });

  it("don't make a steady page look as if it's losing its traffic", async () => {
    const { workspaceId, site: { id } } = await seat();
    // Four weeks up to yesterday reported only up to 22 October: half of them.
    const days = Array.from({ length: 42 }, (_, index) => day(new Date(Date.UTC(2026, 8, 11 + index)).toISOString().slice(0, 10), 10, 100));
    await storePage(db, workspaceId, id, "https://acme.example/steady", days);
    expect(await decayingPagesOf(db, workspaceId, id, NOW)).toEqual([]);
  });

  it("count on neither side when nothing of the period has been reported", async () => {
    const { workspaceId, site: { id } } = await seat();
    await storeTotals(db, workspaceId, id, "google", steady(23, 29));
    const { totals, totalsBefore } = await overviewOf(db, workspaceId, { sites: id, period: WEEK });
    expect(totals.clicks).toBe(0);
    expect(totalsBefore.clicks).toBe(0);
  });
});

describe("keywords followed", () => {
  it("say where they stand, how they moved, and each day of the period", async () => {
    const { workspaceId, site: { id, name } } = await seat();
    const keywordId = await storeKeyword(db, workspaceId, id, "acme pricing", [day("2026-11-03", 1, 10, 5), day("2026-11-05", 2, 30, 3), day("2026-11-01", 9, 10, 8)]);
    await trackKeyword(db, workspaceId, id, "acme pricing");
    // Position: (5 × 10 + 3 × 30) / 40 = 3.5.
    expect(await trackedKeywordsOf(db, workspaceId, id, THREE_DAYS)).toEqual([{ id: keywordId, text: "acme pricing", siteId: id, siteName: name, clicks: 3, impressions: 40, position: 3.5, positionBefore: 8, history: [5, null, 3] }]);
  });

  it("are empty handed when never seen in search", async () => {
    const { workspaceId, site: { id } } = await seat();
    await trackKeyword(db, workspaceId, id, "hoped for");
    expect(await trackedKeywordsOf(db, workspaceId, id, THREE_DAYS)).toMatchObject([{ text: "hoped for", clicks: 0, impressions: 0, position: null, positionBefore: null, history: [null, null, null] }]);
  });

  it("are only those followed, by site then by words", async () => {
    const { workspaceId, site: { id } } = await seat();
    const other = await followSite(db, workspaceId, "alpha.example");
    await storeKeyword(db, workspaceId, id, "not followed", [day("2026-11-05", 1, 10)]);
    await trackKeyword(db, workspaceId, id, "zebra");
    await trackKeyword(db, workspaceId, id, "apple");
    await trackKeyword(db, workspaceId, other.id, "mango");
    expect((await trackedKeywordsOf(db, workspaceId, null, THREE_DAYS)).map(({ siteName, text }) => [siteName, text])).toEqual([["acme.example", "apple"], ["acme.example", "zebra"], ["alpha.example", "mango"]]);
    expect((await trackedKeywordsOf(db, workspaceId, other.id, THREE_DAYS)).map(({ text }) => text)).toEqual(["mango"]);
  });

  it("are nothing when nothing's followed, and nothing of another workspace", async () => {
    const mine = await seat();
    const stranger = await seat("third.example");
    await trackKeyword(db, stranger.workspaceId, stranger.site.id, "theirs");
    expect(await trackedKeywordsOf(db, mine.workspaceId, null, THREE_DAYS)).toEqual([]);
    expect(await trackedKeywordsOf(db, mine.workspaceId, stranger.site.id, THREE_DAYS)).toEqual([]);
  });
});

describe("the most clicked of the keywords followed", () => {
  it("come first, then by name, up to the limit", async () => {
    const { workspaceId, site: { id } } = await seat();
    for (const [text, clicks] of [["few", 1], ["many", 9], ["b same", 5], ["a same", 5]] as const) {
      await storeKeyword(db, workspaceId, id, text, [day("2026-11-01", clicks, 100)]);
      await trackKeyword(db, workspaceId, id, text);
    }
    const tracked = await trackedKeywordsOf(db, workspaceId, id, WEEK);
    expect(mostClicked(tracked, 3).map(({ text }) => text)).toEqual(["many", "a same", "b same"]);
    expect(tracked).toHaveLength(4);
  });
});

describe("following a keyword", () => {
  const keywordsIn = (workspaceId: string) => withWorkspace(db, workspaceId, (tx) => tx.select().from(keyword));

  it("makes it, lower-cased and trimmed, when it's new", async () => {
    const { workspaceId, site: { id } } = await seat();
    expect(await trackKeyword(db, workspaceId, id, "  Acme PRICING ")).toEqual({ ok: true, said: "Following “acme pricing”." });
    expect(await keywordsIn(workspaceId)).toMatchObject([{ siteId: id, text: "acme pricing" }]);
  });

  it("uses the one already seen in search, whatever the capitals, with its figures", async () => {
    const { workspaceId, site: { id } } = await seat();
    const seen = await storeKeyword(db, workspaceId, id, "acme pricing", [day("2026-11-05", 2, 30, 3)]);
    await trackKeyword(db, workspaceId, id, "ACME Pricing");
    expect(await keywordsIn(workspaceId)).toHaveLength(1);
    expect(await trackedKeywordsOf(db, workspaceId, id, THREE_DAYS)).toMatchObject([{ id: seen, clicks: 2, position: 3 }]);
  });

  it("twice follows it once", async () => {
    const { workspaceId, site: { id } } = await seat();
    await trackKeyword(db, workspaceId, id, "acme");
    expect((await trackKeyword(db, workspaceId, id, "acme")).ok).toBe(true);
    expect(await trackedKeywordsOf(db, workspaceId, id, THREE_DAYS)).toHaveLength(1);
  });

  it("wants words, and keeps 300 at most", async () => {
    const { workspaceId, site: { id } } = await seat();
    expect(await trackKeyword(db, workspaceId, id, "   ")).toEqual({ ok: false, error: "Say which keyword." });
    await trackKeyword(db, workspaceId, id, "x".repeat(301));
    expect((await keywordsIn(workspaceId))[0].text).toHaveLength(300);
  });

  it("wants a site of this workspace", async () => {
    const mine = await seat();
    const stranger = await seat("third.example");
    const none = { ok: false, error: "There’s no such site here." };
    expect(await trackKeyword(db, mine.workspaceId, stranger.site.id, "acme")).toEqual(none);
    expect(await trackKeyword(db, mine.workspaceId, "not-an-id", "acme")).toEqual(none);
    expect(await keywordsIn(stranger.workspaceId)).toEqual([]);
  });
});

describe("no longer following a keyword", () => {
  it("stops following it, and what's stored about it stays", async () => {
    const { workspaceId, site: { id } } = await seat();
    const keywordId = await storeKeyword(db, workspaceId, id, "acme", [day("2026-11-05", 1, 10)]);
    await trackKeyword(db, workspaceId, id, "acme");
    expect(await untrackKeyword(db, workspaceId, id, keywordId)).toEqual({ ok: true, said: "No longer following it." });
    expect(await trackedKeywordsOf(db, workspaceId, id, THREE_DAYS)).toEqual([]);
    expect(await withWorkspace(db, workspaceId, (tx) => tx.select().from(keywordDay))).toHaveLength(1);
  });

  it("says so when it wasn't followed", async () => {
    const { workspaceId, site: { id } } = await seat();
    const keywordId = await storeKeyword(db, workspaceId, id, "acme");
    const refused = { ok: false, error: "That keyword isn’t followed here." };
    expect(await untrackKeyword(db, workspaceId, id, keywordId)).toEqual(refused);
    expect(await untrackKeyword(db, workspaceId, "not-an-id", keywordId)).toEqual(refused);
  });

  it("can't touch another workspace's", async () => {
    const mine = await seat();
    const stranger = await seat("third.example");
    const keywordId = await storeKeyword(db, stranger.workspaceId, stranger.site.id, "theirs");
    await trackKeyword(db, stranger.workspaceId, stranger.site.id, "theirs");
    expect((await untrackKeyword(db, mine.workspaceId, stranger.site.id, keywordId)).ok).toBe(false);
    expect(await trackedKeywordsOf(db, stranger.workspaceId, stranger.site.id, THREE_DAYS)).toHaveLength(1);
  });
});
