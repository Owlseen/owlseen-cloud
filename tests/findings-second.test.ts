import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { alertsOf } from "@/application/alerts";
import { figuresOf } from "@/application/figures";
import { runIndexChecks } from "@/application/indexing";
import { overviewOf } from "@/application/overview";
import type { Services } from "@/application/services";
import { sitesOf } from "@/application/sites";
import { syncDueSites } from "@/application/sync";
import { periodEndingAt } from "@/application/time-range";
import type { Database } from "@/infrastructure/db/client";
import { keywordDay, searchDay, site } from "@/infrastructure/db/schema/search";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { fakeFetch, type FakeRoute } from "./support/fetch";
import { connectGoogle, followSite, GOOGLE_TOKEN, googleProperty, INSPECT, inspected, NOW, storePage, storeTotals, testServices, testSettings } from "./support/search";

const ACME = "sc-domain:acme.example";
const FAR = NOW.getTime() + 3_600_000;

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
}, 400_000);
beforeEach(async () => {
  await db.delete(site);
});

const googleSeat = async () => {
  const seat = await createTestWorkspace(db);
  await connectGoogle(testServices(db).services, seat.workspaceId, seat.userId);
  return seat;
};
const setRead = (workspaceId: string, siteId: string, at: Date | null, error: string | null = null) => withWorkspace(db, workspaceId, (tx) => tx.update(site).set({ lastSyncedAt: at, googleReadAt: at, lastSyncError: error }).where(eq(site.id, siteId)));
const asked = (calls: { url: string; body: string }[]) => calls.filter(({ url }) => url.endsWith("/searchAnalytics/query")).map(({ url, body }) => ({ site: decodeURIComponent(url.split("/sites/")[1].split("/")[0]), ...(JSON.parse(body) as { dimensions: string[]; startDate: string; startRow: number }) }));
const steady = (from: number, to: number, clicks = 100) => Array.from({ length: to - from + 1 }, (_, index) => ({ day: new Date(Date.UTC(2026, 9, from + index)).toISOString().slice(0, 10), clicks, impressions: clicks * 10, position: 5 }));

describe("a site that was read fine and has lost all its traffic", () => {
  it("alerts when it fell to nothing five days ago, another site showing Google has got past that", async () => {
    const { workspaceId } = await googleSeat();
    const one = await followSite(db, workspaceId, "acme.example");
    const other = await followSite(db, workspaceId, "northwind.example");
    await setRead(workspaceId, one.id, NOW);
    await setRead(workspaceId, other.id, NOW);
    // Steady at 100 a day to 31 October, then Google lists no row at all: it says nothing of a day with no impressions.
    await storeTotals(db, workspaceId, one.id, "google", steady(1, 31));
    await storeTotals(db, workspaceId, other.id, "google", steady(1, 33));
    expect((await alertsOf(db, workspaceId, one.id, NOW))).toMatchObject([{ severity: "high", quietSince: "2026-10-31" }]);
    expect(await alertsOf(db, workspaceId, other.id, NOW)).toEqual([]);
  });

  it("waits a week or so when the site is alone, with nothing to say how late Google is", async () => {
    const { workspaceId } = await googleSeat();
    const one = await followSite(db, workspaceId, "acme.example");
    await setRead(workspaceId, one.id, NOW);
    await storeTotals(db, workspaceId, one.id, "google", steady(1, 31));
    expect((await alertsOf(db, workspaceId, one.id, NOW)).some(({ quietSince }) => quietSince)).toBe(false);
    await withWorkspace(db, workspaceId, (tx) => tx.delete(searchDay).where(eq(searchDay.siteId, one.id)));
    await storeTotals(db, workspaceId, one.id, "google", steady(1, 27));
    expect(await alertsOf(db, workspaceId, one.id, NOW)).toMatchObject([{ severity: "high", quietSince: "2026-10-27" }]);
  });

  it("still alerts a fortnight later", async () => {
    const { workspaceId } = await googleSeat();
    const one = await followSite(db, workspaceId, "acme.example");
    await setRead(workspaceId, one.id, NOW);
    await storeTotals(db, workspaceId, one.id, "google", steady(1, 21));
    expect(await alertsOf(db, workspaceId, one.id, NOW)).toMatchObject([{ severity: "high" }]);
  });

  it("shows the overview as a fall, not as nothing to compare", async () => {
    const { workspaceId } = await googleSeat();
    const one = await followSite(db, workspaceId, "acme.example");
    await setRead(workspaceId, one.id, NOW);
    await storeTotals(db, workspaceId, one.id, "google", steady(1, 21));
    const { totals, totalsBefore } = await overviewOf(db, workspaceId, { sites: one.id, period: periodEndingAt(NOW, 7) });
    expect(totals.clicks).toBe(0);
    expect(totalsBefore.clicks).toBeGreaterThan(0);
  });
});

describe("a site on two engines with no account on one", () => {
  /** Two engines' names, Google connected, Bing not. */
  async function sites(count: number) {
    const { workspaceId } = await googleSeat();
    const made = [];
    for (let index = 0; index < count; index += 1) {
      const one = await followSite(db, workspaceId, `site${index}.example`, { googleProperty: `sc-domain:site${index}.example`, bingSite: `https://site${index}.example/` });
      await setRead(workspaceId, one.id, new Date(Date.UTC(2026, 9, 20, 9, index)), "No connected Bing account can read this site.");
      made.push(one);
    }
    return { workspaceId, made };
  }
  const routesFor = (count: number): FakeRoute[] => [GOOGLE_TOKEN, ...Array.from({ length: count }, (_, index) => googleProperty(`sc-domain:site${index}.example`)).flat()];

  it("reads the other engine once a day, not on every run", async () => {
    const { workspaceId } = await googleSeat();
    const one = await followSite(db, workspaceId, "acme.example", { bingSite: "https://www.acme.example/" });
    await setRead(workspaceId, one.id, null);
    const { services, calls } = testServices(db, [GOOGLE_TOKEN, ...googleProperty(ACME)]);
    for (let run = 0; run < 3; run += 1) await syncDueSites(services, FAR);
    const firstReads = asked(calls).filter(({ dimensions, startDate }) => dimensions.join() === "date" && startDate === "2025-07-13");
    expect(firstReads).toHaveLength(1);
  });

  it("doesn't widen what it re-reads every day it stays unread on the other engine", async () => {
    const { workspaceId } = await googleSeat();
    await followSite(db, workspaceId, "acme.example", { bingSite: "https://www.acme.example/" });
    await syncDueSites(testServices(db, [GOOGLE_TOKEN, ...googleProperty(ACME)]).services, FAR);
    let start: string | undefined;
    // Each day's read, a fortnight on, with Bing still not connected.
    for (let day = 1; day <= 14; day += 1) {
      const now = new Date(NOW.getTime() + day * 86_400_000);
      const { services, calls } = testServices(db, [GOOGLE_TOKEN, ...googleProperty(ACME)], now);
      await syncDueSites(services, now.getTime() + 3_600_000);
      start = asked(calls).find(({ dimensions }) => dimensions.join() === "query,date")?.startDate;
    }
    // Read last on 18 November, as on every day before: 10 days before that.
    expect(start).toBe("2026-11-08");
  });

  it("reaches every site over a day's three runs, when a run only has time for one", async () => {
    await sites(3);
    const reached = new Set<string>();
    for (let run = 0; run < 3; run += 1) {
      const deadline = NOW.getTime() + 60_000;
      const clock = { now: NOW.getTime() };
      const network = fakeFetch(routesFor(3));
      const moving = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const answer = await network.fetch(input, init);
        clock.now = deadline;
        return answer;
      }) as typeof fetch;
      const services: Services = { db, settings: testSettings, fetch: moving, now: () => new Date(clock.now), wait: async () => {} };
      await syncDueSites(services, deadline);
      for (const one of asked(network.calls)) reached.add(one.site);
    }
    expect(reached.size).toBe(3);
  });
});

describe("a read the platform kills", () => {
  /** A property with 1,500 rows a day: over four pages for 91 days, so it's read in slices, each answer a real page. */
  const rowsOf = (from: string, to: string) => {
    const days: string[] = [];
    for (let at = new Date(`${from}T00:00:00Z`); at <= new Date(`${to}T00:00:00Z`); at = new Date(at.getTime() + 86_400_000)) days.push(at.toISOString().slice(0, 10));
    return days;
  };
  function platform(killAfterCalls: number) {
    let calls = 0;
    const seen: string[] = [];
    const fetchIt = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = input.toString();
      if (url.includes("oauth2.googleapis.com")) return Response.json({ access_token: "token" });
      seen.push(decodeURIComponent(url.split("/sites/")[1]?.split("/")[0] ?? url));
      if (url.includes("northwind")) return url.endsWith("/sitemaps") ? Response.json({}) : Response.json({ rows: [] });
      if (url.endsWith("/sitemaps")) return Response.json({});
      const body = JSON.parse(String(init.body)) as { startDate: string; endDate: string; dimensions: string[]; rowLimit: number; startRow: number };
      if (body.dimensions.length === 1) return Response.json({ rows: rowsOf(body.startDate, body.endDate).map((day) => ({ keys: [day], clicks: 1, impressions: 5, position: 4 })) });
      calls += 1;
      // The function is gone: nothing after this runs, as when the platform stops it at its limit.
      if (calls > killAfterCalls) return new Promise<Response>(() => {});
      const days = rowsOf(body.startDate, body.endDate);
      const total = days.length * 1_500;
      const rows = Array.from({ length: Math.min(Math.max(total - body.startRow, 0), body.rowLimit) }, (_, index) => {
        const at = body.startRow + index;
        return { keys: [`word ${at % 1_500}`, days[Math.floor(at / 1_500)]], clicks: 1, impressions: 5, position: 4 };
      });
      return Response.json({ rows });
    }) as typeof fetch;
    return { fetchIt, seen };
  }
  const runUntilKilled = async (services: Services) => {
    await Promise.race([syncDueSites(services, FAR), new Promise((done) => setTimeout(done, 4_000))]);
  };

  it("doesn't keep its place at the head of the queue, and doesn't lose every page it read", async () => {
    const big = await googleSeat();
    const other = await googleSeat();
    await followSite(db, big.workspaceId, "acme.example");
    const healthy = await followSite(db, other.workspaceId, "northwind.example");
    await setRead(other.workspaceId, healthy.id, new Date("2026-11-04T09:00:00Z"));
    const first = platform(5);
    await runUntilKilled({ db, settings: testSettings, fetch: first.fetchIt, now: () => NOW, wait: async () => {} });
    const [row] = await sitesOf(db, big.workspaceId);
    const stored = await withWorkspace(db, big.workspaceId, (tx) => tx.select({ day: keywordDay.day }).from(keywordDay).limit(1));
    const second = platform(5);
    await runUntilKilled({ db, settings: testSettings, fetch: second.fetchIt, now: () => NOW, wait: async () => {} });
    // Four at once: the healthy one isn't behind the large one at all, and read in the first run, not the second.
    expect(new Set([...first.seen, ...second.seen])).toContain("sc-domain:northwind.example");
    expect((await sitesOf(db, other.workspaceId))[0].lastSyncedAt).toEqual(NOW);
    // What the platform stopped says so, and waits behind the others next time.
    expect(row).toMatchObject({ lastReadFailed: true, lastSyncError: "This read didn’t finish. It carries on at the next run." });
    expect(stored.length).toBeGreaterThan(0);
  }, 180_000);
});

describe("index checks when a run's budget is short", () => {
  it("reach every site across runs, whatever its id", async () => {
    const { workspaceId } = await googleSeat();
    const names = ["a", "b", "c", "d", "e", "f"].map((letter) => `${letter}.example`);
    for (const name of names) {
      const one = await followSite(db, workspaceId, name);
      for (let index = 0; index < 8; index += 1) await storePage(db, workspaceId, one.id, `https://${name}/${index}`);
    }
    const reached = new Set<string>();
    for (let run = 0; run < 4; run += 1) {
      const deadline = NOW.getTime() + 60_000;
      const clock = { now: NOW.getTime() };
      const network = fakeFetch([GOOGLE_TOKEN, { match: INSPECT, json: inspected("PASS", "Submitted and indexed") }]);
      let inspections = 0;
      const moving = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const answer = await network.fetch(input, init);
        if (input.toString().includes("urlInspection")) inspections += 1;
        if (inspections >= 4) clock.now = deadline;
        return answer;
      }) as typeof fetch;
      await runIndexChecks({ db, settings: testSettings, fetch: moving, now: () => new Date(clock.now), wait: async () => {} }, deadline);
      for (const { url, body } of network.calls) if (url.includes("urlInspection")) reached.add(new URL((JSON.parse(body) as { inspectionUrl: string }).inspectionUrl).hostname);
    }
    expect(reached.size).toBe(names.length);
  });

  it("never asks about one page twice in a run, with four at once", async () => {
    const { workspaceId } = await googleSeat();
    const one = await followSite(db, workspaceId, "acme.example");
    for (let index = 0; index < 150; index += 1) await storePage(db, workspaceId, one.id, `https://acme.example/${index}`);
    const { services, calls } = testServices(db, [GOOGLE_TOKEN, { match: INSPECT, json: inspected("PASS", "Submitted and indexed") }]);
    await runIndexChecks(services, FAR);
    const urls = calls.filter(({ url }) => url.includes("urlInspection")).map(({ body }) => (JSON.parse(body) as { inspectionUrl: string }).inspectionUrl);
    expect(urls).toHaveLength(100);
    expect(new Set(urls).size).toBe(100);
  });
});

describe("a provider asking to wait", () => {
  it("doesn't hold a run past the function's limit", async () => {
    const { workspaceId } = await googleSeat();
    for (const name of ["acme.example", "northwind.example", "third.example"]) await followSite(db, workspaceId, name);
    const clock = { now: NOW.getTime() };
    const limited: FakeRoute[] = [GOOGLE_TOKEN, { match: "POST https://www.googleapis.com/webmasters/v3/sites", status: 429, json: { error: { message: "Quota exceeded" } }, headers: { "retry-after": "60" } }];
    const network = fakeFetch(limited);
    const services: Services = { db, settings: testSettings, fetch: network.fetch, now: () => new Date(clock.now), wait: async (ms) => void (clock.now += ms) };
    await syncDueSites(services, NOW.getTime() + 270_000);
    const seconds = (clock.now - NOW.getTime()) / 1_000;
    expect(seconds).toBeLessThanOrEqual(300);
  });
});

describe("the figures API's page", () => {
  it("doesn't fail on a page number too big to mean anything", async () => {
    const { workspaceId } = await googleSeat();
    const page = Math.max(Math.trunc(Number("1e309")) || 1, 1);
    await expect(figuresOf(db, workspaceId, periodEndingAt(NOW, 1), undefined, page)).resolves.toMatchObject({ sites: [] });
  });
});
