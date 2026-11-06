import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { alertsOf } from "@/application/alerts";
import { movedKeywordsOf } from "@/application/keywords";
import { overviewOf } from "@/application/overview";
import type { Services } from "@/application/services";
import { sitesOf } from "@/application/sites";
import { syncDueSites } from "@/application/sync";
import { periodEndingAt } from "@/application/time-range";
import type { Database } from "@/infrastructure/db/client";
import { keywordDay, pageDay, searchDay, site } from "@/infrastructure/db/schema/search";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { connectBing, connectGoogle, followSite, testServices, testSettings } from "./support/search";

const DAY = 86_400_000;
const at = (day: string, hour = 5) => new Date(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
const plus = (day: string, days: number) => new Date(new Date(`${day}T00:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10);
const span = (from: string, to: string) => { const days: string[] = []; for (let d = from; d <= to; d = plus(d, 1)) days.push(d); return days; };

/** A Google and a Bing that behave as their docs say: a day appears only once finished, rows only for days with impressions. */
class World {
  now = at("2026-10-01");
  lag = 3;
  bingLag = 2;
  published: string | null = null;
  tokenDead = false;
  sitemapStatus = 200;
  clicks: (property: string, day: string) => number = () => 100;
  bingClicks: (property: string, day: string) => number = () => 5;
  calls: string[] = [];
  get today() { return this.now.toISOString().slice(0, 10); }
  fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = input.toString();
    if (url.includes("oauth2.googleapis.com")) return this.tokenDead ? Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 }) : Response.json({ access_token: "t" });
    if (url.includes("ssl.bing.com")) {
      this.calls.push(url);
      if (url.includes("GetFeeds")) return Response.json({ d: [] });
      const property = new URL(url).searchParams.get("siteUrl") as string;
      const days = span(plus(this.today, -60), plus(this.today, -this.bingLag)).filter((day) => this.bingClicks(property, day) > 0);
      return Response.json({ d: days.map((day) => ({ Date: `/Date(${new Date(`${day}T08:00:00Z`).getTime()})/`, Clicks: this.bingClicks(property, day), Impressions: 50 })) });
    }
    const property = decodeURIComponent(url.split("/sites/")[1].split("/")[0]);
    this.calls.push(url);
    if (url.endsWith("/sitemaps")) return this.sitemapStatus === 200 ? Response.json({}) : Response.json({ error: { message: "User does not have sufficient permission for site" } }, { status: this.sitemapStatus });
    const { startDate, endDate, dimensions, startRow } = JSON.parse(String(init.body)) as { startDate: string; endDate: string; dimensions: string[]; startRow: number };
    if (startRow > 0) return Response.json({ rows: [] });
    const lastFinal = plus(this.today, -this.lag);
    const last = [endDate, lastFinal, this.published ?? endDate].sort()[0];
    const days = span(startDate, last).filter((day) => this.clicks(property, day) > 0);
    const rows = days.flatMap((day) => {
      const clicks = this.clicks(property, day);
      if (dimensions.length === 1) return [{ keys: [day], clicks, impressions: clicks * 10, position: 5 }];
      const names = dimensions[0] === "query" ? ["alpha", "beta"] : [`https://${property.replace("sc-domain:", "")}/a`, `https://${property.replace("sc-domain:", "")}/b`];
      return names.map((name) => ({ keys: [name, day], clicks: clicks / 2, impressions: clicks * 5, position: 5 }));
    });
    return Response.json({ rows });
  }) as typeof fetch;
  services(): Services { return { db, settings: testSettings, fetch: this.fetch, now: () => this.now, wait: async () => {} }; }
  read(day: string, hour = 5) { this.now = at(day, hour); return syncDueSites(this.services(), this.now.getTime() + 200_000); }
}

let db: Database;
beforeAll(async () => { db = await createTestDatabase(); }, 400_000);
beforeEach(async () => { await db.delete(site); });

async function seat(names: string[], bing = false) {
  const { workspaceId, userId } = await createTestWorkspace(db);
  await connectGoogle(testServices(db).services, workspaceId, userId);
  if (bing) await connectBing(testServices(db, [{ match: "GET https://ssl.bing.com/webmaster/api.svc/json/GetUserSites", json: { d: [] } }]).services, workspaceId, userId);
  const sites = [];
  for (const name of names) sites.push(await followSite(db, workspaceId, name, bing ? { bingSite: `https://${name}/` } : {}));
  return { workspaceId, sites };
}
const say = (alerts: Awaited<ReturnType<typeof alertsOf>>) => alerts.map(({ siteName, severity, quietSince, clicks, clicksBefore }) => `${siteName}:${severity}${quietSince ? `:quiet since ${quietSince}` : ""}:${clicks}/${clicksBefore}`);

describe("gone quiet", () => {
  it("doesn't fire when reads are failing, day by day after a token dies", async () => {
    const world = new World();
    const { workspaceId } = await seat(["a.example", "b.example", "c.example"]);
    for (const day of span("2026-10-01", "2026-11-01")) await world.read(day);
    expect(await alertsOf(db, workspaceId, null, at("2026-11-01", 12))).toEqual([]);
    world.tokenDead = true;
    const seen: Record<string, string[]> = {};
    for (const day of span("2026-11-02", "2026-11-10")) {
      await world.read(day);
      seen[day] = say(await alertsOf(db, workspaceId, null, at(day, 12)));
    }
    expect(Object.values(seen).flat()).toEqual([]);
    const [row] = await sitesOf(db, workspaceId);
    expect(row.lastReadFailed).toBe(true);
    const { connectionsNotWorking } = await import("@/application/connections");
    expect(await connectionsNotWorking(testServices(db).services, workspaceId)).toMatchObject([{ kind: "google", status: "failing" }]);
  }, 180_000);

  it("doesn't read as a fall on the overview while reads are failing", async () => {
    const world = new World();
    const { workspaceId, sites } = await seat(["a.example"]);
    for (const day of span("2026-10-01", "2026-11-01")) await world.read(day);
    world.tokenDead = true;
    const seen: Record<string, string> = {};
    for (const day of span("2026-11-02", "2026-11-06")) {
      await world.read(day);
      const { totals, totalsBefore } = await overviewOf(db, workspaceId, { sites: sites[0].id, period: periodEndingAt(at(day, 12), 7) });
      seen[day] = `${totals.clicks}/${totalsBefore.clicks}`;
    }
    expect(Object.values(seen).every((pair) => { const [a, b] = pair.split("/").map(Number); return b === 0 || a === b; })).toBe(true);
  }, 180_000);

  it("stays silent on a normal day at any hour, Google three days late", async () => {
    const world = new World();
    const { workspaceId } = await seat(["a.example", "b.example"]);
    for (const day of span("2026-10-01", "2026-11-05")) await world.read(day);
    const seen: string[] = [];
    for (const hour of [6, 12, 23]) seen.push(...say(await alertsOf(db, workspaceId, null, at("2026-11-05", hour))));
    seen.push(...say(await alertsOf(db, workspaceId, null, at("2026-11-06", 2))));
    expect(seen).toEqual([]);
  }, 180_000);

  it("doesn't fire on every site overnight if Google is four days late at the morning read", async () => {
    const world = new World();
    world.lag = 4;
    const { workspaceId } = await seat(["a.example", "b.example", "c.example"]);
    for (const day of span("2026-10-01", "2026-11-05")) await world.read(day);
    const night = say(await alertsOf(db, workspaceId, null, at("2026-11-06", 2)));
    expect(night).toEqual([]);
  }, 180_000);

  it("doesn't fire on every site when Google publishes nothing for two days", async () => {
    const world = new World();
    const { workspaceId } = await seat(["a.example", "b.example", "c.example"]);
    for (const day of span("2026-10-01", "2026-11-03")) await world.read(day);
    world.published = plus("2026-11-03", -3);
    const seen: Record<string, string[]> = {};
    for (const day of span("2026-11-04", "2026-11-06")) { await world.read(day); seen[day] = say(await alertsOf(db, workspaceId, null, at(day, 12))); }
    expect(Object.values(seen).flat()).toEqual([]);
  }, 180_000);

  it("a site that really stops: when it fires, and for how long", async () => {
    const world = new World();
    const stop = "2026-10-20";
    world.clicks = (property, day) => (property.includes("a.example") && day > stop ? 0 : 100);
    const { workspaceId } = await seat(["a.example", "b.example"]);
    for (const day of span("2026-10-01", "2026-10-20")) await world.read(day);
    const fired: string[] = [];
    let first = "", last = "";
    for (const day of span("2026-10-21", "2026-12-20")) {
      await world.read(day);
      const alert = (await alertsOf(db, workspaceId, null, at(day, 12))).find(({ siteName }) => siteName === "a.example");
      if (alert) { first ||= day; last = day; if (fired.length < 4 || day > "2026-11-27") fired.push(`${day}:${alert.severity}:${alert.quietSince ?? "-"}:${alert.clicks}/${alert.clicksBefore}`); }
    }
    const other = (await alertsOf(db, workspaceId, null, at("2026-11-01", 12))).filter(({ siteName }) => siteName === "b.example");
    expect(other).toEqual([]);
    expect(first).not.toBe("");
    // Said for six weeks after its last row, then it's old news.
    expect((new Date(last).getTime() - new Date(stop).getTime()) / DAY).toBe(42);
  }, 300_000);

  it("typical low traffic with empty days stays silent", async () => {
    const world = new World();
    world.clicks = (_, day) => (new Date(day).getUTCDate() % 4 === 0 ? 2 : 0);
    const { workspaceId } = await seat(["low.example"]);
    const seen: string[] = [];
    for (const day of span("2026-10-01", "2026-11-20")) { await world.read(day); seen.push(...say(await alertsOf(db, workspaceId, null, at(day, 12)))); }
    expect(seen).toEqual([]);
  }, 300_000);

  it("a flat site whose traffic comes in weekly bursts", async () => {
    const world = new World();
    world.clicks = (_, day) => (new Date(day).getUTCDay() === 1 ? 15 : 0);
    const { workspaceId } = await seat(["bursts.example"]);
    const seen: string[] = [];
    const days = span("2026-10-01", "2026-11-20");
    for (const day of days) { await world.read(day); seen.push(...say(await alertsOf(db, workspaceId, null, at(day, 12))).map((said) => `${day} ${said}`)); }
    expect(seen).toEqual([]);
  }, 300_000);

  it("a new site, read for the first time, says nothing", async () => {
    const world = new World();
    world.now = at("2026-11-05");
    world.clicks = (_, day) => (day >= "2026-10-28" ? 50 : 0);
    const { workspaceId } = await seat(["new.example"]);
    await world.read("2026-11-05");
    expect(await alertsOf(db, workspaceId, null, at("2026-11-05", 12))).toEqual([]);
  }, 180_000);

  it("two engines: Bing stops dead, Google steady, says nothing", async () => {
    const world = new World();
    world.bingClicks = (_, day) => (day > "2026-10-25" ? 0 : 5);
    const { workspaceId } = await seat(["a.example"], true);
    const seen: string[] = [];
    for (const day of span("2026-10-01", "2026-11-05")) { await world.read(day); if (day > "2026-10-25") seen.push(...say(await alertsOf(db, workspaceId, null, at(day, 12)))); }
    expect(seen).toEqual([]);
  }, 300_000);

  it("two engines: Google stops dead, Bing steady, alerts as a real fall", async () => {
    const world = new World();
    world.clicks = (_, day) => (day > "2026-10-25" ? 0 : 100);
    const { workspaceId } = await seat(["a.example"], true);
    let last: string[] = [];
    for (const day of span("2026-10-01", "2026-11-05")) { await world.read(day); if (day > "2026-10-25") last = say(await alertsOf(db, workspaceId, null, at(day, 12))); }
    expect(last.join()).toContain("high");
  }, 300_000);

  it("two engines: Google's reads fail, Bing is fine, says nothing of a fall", async () => {
    const world = new World();
    const { workspaceId } = await seat(["a.example"], true);
    for (const day of span("2026-10-01", "2026-11-01")) await world.read(day);
    world.tokenDead = true;
    const seen: Record<string, string[]> = {};
    for (const day of span("2026-11-02", "2026-11-08")) { await world.read(day); seen[day] = say(await alertsOf(db, workspaceId, null, at(day, 12))); }
    expect(Object.values(seen).flat()).toEqual([]);
  }, 300_000);
});

describe("reads resuming", () => {
  const stored = async (workspaceId: string, table: typeof keywordDay | typeof pageDay) => [...new Set((await withWorkspace(db, workspaceId, (tx) => tx.select({ day: table.day }).from(table as typeof keywordDay))).map(({ day }) => day))].sort();
  const holes = (days: string[], from: string, to: string) => span(from, to).filter((day) => !days.includes(day));

  for (const length of [3, 12, 20]) {
    it(`leaves no hole in keywords or totals after sitemaps fail for ${length} days, once they work again`, async () => {
      const world = new World();
      const { workspaceId } = await seat(["a.example"]);
      for (const day of span("2026-09-01", "2026-09-10")) await world.read(day);
      world.sitemapStatus = 403;
      const failing = span("2026-09-11", plus("2026-09-11", length - 1));
      for (const day of failing) await world.read(day);
      world.sitemapStatus = 200;
      const after = span(plus("2026-09-11", length), plus("2026-09-11", length + 12));
      for (const day of after) await world.read(day);
      const end = plus(after.at(-1) as string, -3);
      const missing = holes(await stored(workspaceId, keywordDay), "2026-08-20", end);
      const totals = holes([...new Set((await withWorkspace(db, workspaceId, (tx) => tx.select({ day: searchDay.day }).from(searchDay))).map(({ day }) => day))].sort(), "2026-08-20", end);
      expect(missing).toEqual([]);
      expect(totals).toEqual([]);
    }, 300_000);
  }

  it("is idempotent: a read done twice changes no figure", async () => {
    const world = new World();
    const { workspaceId } = await seat(["a.example"]);
    await world.read("2026-10-01");
    const sum = async () => (await withWorkspace(db, workspaceId, (tx) => tx.select({ clicks: keywordDay.clicks }).from(keywordDay))).reduce((total, { clicks }) => total + clicks, 0);
    const once = await sum();
    await withWorkspace(db, workspaceId, (tx) => tx.update(site).set({ lastSyncedAt: null, googleReadAt: null, keywordsReadThrough: "2026-08-20", pagesReadThrough: "2026-08-20" }));
    await world.read("2026-10-01");
    expect(await sum()).toBe(once);
  }, 180_000);

  it("a half-read site shows no keyword fall", async () => {
    const world = new World();
    world.now = at("2026-11-05");
    const { workspaceId } = await seat(["a.example"]);
    await world.read("2026-11-05");
    await withWorkspace(db, workspaceId, (tx) => tx.update(site).set({ googleReadAt: null, lastSyncError: "This read didn’t finish. It carries on at the next run.", lastReadFailed: true, keywordsReadThrough: "2026-10-20" }));
    await withWorkspace(db, workspaceId, (tx) => tx.delete(keywordDay).where(eq(keywordDay.siteId, keywordDay.siteId)));
    const firstHalf = span("2026-08-07", "2026-10-20");
    const [one] = await sitesOf(db, workspaceId);
    expect(one.keywordsReadThrough).toBe("2026-10-20");
    expect(firstHalf.length).toBeGreaterThan(0);
    expect(await movedKeywordsOf(db, workspaceId, { sites: null, period: periodEndingAt(at("2026-11-05", 12), 28) })).toEqual([]);
  }, 180_000);
});

describe("whose turn it is, after a read was stopped", () => {
  it("sends those a read was stopped on behind healthy ones, even more of them than run at once", async () => {
    const world = new World();
    const { workspaceId, sites } = await seat(["k1.example", "k2.example", "k3.example", "k4.example", "k5.example", "healthy.example"]);
    for (const one of sites.slice(0, 5)) await withWorkspace(db, workspaceId, (tx) => tx.update(site).set({ lastSyncError: "This read didn’t finish. It carries on at the next run.", lastReadFailed: true, lastSyncedAt: new Date("2026-10-01T05:00:00Z") }).where(eq(site.id, one.id)));
    await withWorkspace(db, workspaceId, (tx) => tx.update(site).set({ lastSyncedAt: new Date("2026-11-04T05:00:00Z") }).where(eq(site.id, sites[5].id)));
    await world.read("2026-11-05");
    const order = [...new Set(world.calls.map((url) => decodeURIComponent(url.split("/sites/")[1].split("/")[0])))];
    expect(order[0]).toBe("sc-domain:healthy.example");
  }, 180_000);
});
