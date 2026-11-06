import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accessOfKey, createApiKey } from "@/application/api-keys";
import { connectionsOf } from "@/application/connections";
import { inspectPage, runIndexChecks, submitSitemap } from "@/application/indexing";
import type { Services } from "@/application/services";
import { addSites, sitesAvailable, sitesOf } from "@/application/sites";
import { syncDueSites } from "@/application/sync";
import { removeMember } from "@/application/team";
import type { Database } from "@/infrastructure/db/client";
import { connection } from "@/infrastructure/db/schema/connections";
import { page, site } from "@/infrastructure/db/schema/search";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { fakeFetch, type FakeRoute, type RecordedCall } from "./support/fetch";
import { BING_SITES, bingFigures, connectBing, connectGoogle, followSite, GOOGLE_TOKEN, GOOGLE_USER, googleProperty, googlePropertyFailing, googleSites, INSPECT, inspected, NEXT_DAY, NOW, servicesRunningOutOfTime, storePage, teammate, testServices, testSettings } from "./support/search";

const ACME = "sc-domain:acme.example";
const NORTHWIND = "sc-domain:northwind.example";
const FAR = NOW.getTime() + 3_600_000;
const BING_STATS = "GET https://ssl.bing.com/webmaster/api.svc/json/GetRankAndTrafficStats";

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
const lastSyncedOn = (workspaceId: string, siteId: string, at: Date) => withWorkspace(db, workspaceId, (tx) => tx.update(site).set({ lastSyncedAt: at }).where(eq(site.id, siteId)));
const asked = (calls: RecordedCall[], dimensions: string) =>
  calls
    .filter(({ url }) => url.endsWith("/searchAnalytics/query"))
    .map(({ body }) => JSON.parse(body) as { dimensions: string[]; startDate: string })
    .filter((one) => one.dimensions.join("+") === dimensions)
    .map(({ startDate }) => startDate);
const statusOf = async (workspaceId: string) => (await connectionsOf(testServices(db).services, workspaceId)).map(({ status }) => status);

describe("a healthy connection isn't marked failing", () => {
  it("when one property of many refuses (access to it was removed in Search Console)", async () => {
    const { workspaceId } = await googleSeat();
    await followSite(db, workspaceId, "acme.example");
    await followSite(db, workspaceId, "northwind.example");
    const { services } = testServices(db, [...googleProperty(ACME), ...googlePropertyFailing(NORTHWIND, 403, "User does not have sufficient permission for site"), GOOGLE_TOKEN]);
    expect(await syncDueSites(services, FAR)).toEqual({ synced: 1, failed: 1, left: 0 });
    expect(await statusOf(workspaceId)).toEqual(["connected"]);
  });

  it("when Google answers 403 for a quota, as it does for Search Analytics", async () => {
    const { workspaceId } = await googleSeat();
    await followSite(db, workspaceId, "acme.example");
    const { services } = testServices(db, [...googlePropertyFailing(ACME, 403, "Search Analytics QPS quota exceeded"), GOOGLE_TOKEN]);
    await syncDueSites(services, FAR);
    expect(await statusOf(workspaceId)).toEqual(["connected"]);
  });
});

describe("a gap in reading is read back", () => {
  it("asks back to the last read after 20 days of failure, not only 10 days", async () => {
    const { workspaceId } = await googleSeat();
    const one = await followSite(db, workspaceId, "acme.example");
    await lastSyncedOn(workspaceId, one.id, new Date("2026-10-16T09:00:00Z"));
    const { services, calls } = testServices(db, [...googleProperty(ACME), GOOGLE_TOKEN]);
    await syncDueSites(services, FAR);
    expect(asked(calls, "date")[0] <= "2026-10-16").toBe(true);
    expect(asked(calls, "query+date")[0] <= "2026-10-16").toBe(true);
  });

  it("doesn't say a site on two engines was read when one had nobody to ask", async () => {
    const seat = await createTestWorkspace(db);
    await connectBing(testServices(db).services, seat.workspaceId, seat.userId);
    await followSite(db, seat.workspaceId, "acme.example", { bingSite: "https://www.acme.example/" });
    const { services } = testServices(db, bingFigures());
    await syncDueSites(services, FAR);
    const [row] = await sitesOf(db, seat.workspaceId);
    expect(row.lastSyncError).not.toBeNull();
  });

  it("gives Google its first read of 480 days when it's connected after Bing already read the site", async () => {
    const seat = await createTestWorkspace(db);
    await connectBing(testServices(db).services, seat.workspaceId, seat.userId);
    await followSite(db, seat.workspaceId, "acme.example", { bingSite: "https://www.acme.example/" });
    await syncDueSites(testServices(db, bingFigures()).services, FAR);
    await connectGoogle(testServices(db).services, seat.workspaceId, seat.userId);
    const { services, calls } = testServices(db, [...googleProperty(ACME), GOOGLE_TOKEN, ...bingFigures()], NEXT_DAY);
    await syncDueSites(services, NEXT_DAY.getTime() + 3_600_000);
    expect(asked(calls, "date")[0]).toBe("2025-07-14");
  });
});

describe("a failing site doesn't starve the others", () => {
  it("across workspaces, over three runs of a day", async () => {
    const stuck = await googleSeat();
    const healthy = await googleSeat();
    const failing = await followSite(db, stuck.workspaceId, "acme.example");
    const fine = await followSite(db, healthy.workspaceId, "northwind.example");
    await lastSyncedOn(stuck.workspaceId, failing.id, new Date("2026-11-01T09:00:00Z"));
    await lastSyncedOn(healthy.workspaceId, fine.id, new Date("2026-11-04T09:00:00Z"));
    const routes: FakeRoute[] = [...googlePropertyFailing(ACME, 500, "Backend error"), ...googleProperty(NORTHWIND), GOOGLE_TOKEN];
    for (let run = 0; run < 3; run += 1) {
      const deadline = NOW.getTime() + 60_000;
      await syncDueSites(servicesRunningOutOfTime(db, routes, deadline).services, deadline);
    }
    const [row] = await sitesOf(db, healthy.workspaceId);
    expect(row.lastSyncedAt?.getTime()).toBeGreaterThan(new Date("2026-11-05T00:00:00Z").getTime());
  });
});

describe("one workspace's broken row doesn't stop the job for everyone", () => {
  it("reads other workspaces when a connection can't be opened", async () => {
    const broken = await createTestWorkspace(db);
    await withWorkspace(db, broken.workspaceId, (tx) => tx.insert(connection).values({ kind: "bing", label: "sealed with another key", sealedCredentials: "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA" }));
    const first = await followSite(db, broken.workspaceId, "acme.example", { googleProperty: null, bingSite: "https://www.acme.example/" });
    await lastSyncedOn(broken.workspaceId, first.id, new Date("2026-11-01T09:00:00Z"));
    const healthy = await googleSeat();
    await followSite(db, healthy.workspaceId, "northwind.example");
    const { services } = testServices(db, [...googleProperty(NORTHWIND), GOOGLE_TOKEN]);
    await expect(syncDueSites(services, FAR)).resolves.toMatchObject({ synced: 1 });
    const [row] = await sitesOf(db, healthy.workspaceId);
    expect(row.lastSyncedAt).not.toBeNull();
  });
});

describe("a provider's error body never carries a secret", () => {
  it("keeps Bing's key out of the site's error when Bing's error page echoes the request", async () => {
    const seat = await createTestWorkspace(db);
    await connectBing(testServices(db).services, seat.workspaceId, seat.userId);
    await followSite(db, seat.workspaceId, "acme.example", { googleProperty: null, bingSite: "https://www.acme.example/" });
    const { services } = testServices(db, [{ match: BING_STATS, status: 500, text: "Server Error at /webmaster/api.svc/json/GetRankAndTrafficStats?apikey=a-bing-key&siteUrl=x" }]);
    await syncDueSites(services, FAR);
    const [row] = await sitesOf(db, seat.workspaceId);
    expect(row.lastSyncError).toBeTruthy();
    expect(row.lastSyncError).not.toContain("a-bing-key");
  });
});

describe("provider calls are bounded in time", () => {
  it("passes a signal to every call, or a hung engine holds the job past its deadline", async () => {
    const { workspaceId } = await googleSeat();
    await followSite(db, workspaceId, "acme.example");
    const signals: (AbortSignal | null | undefined)[] = [];
    const network = fakeFetch([...googleProperty(ACME), GOOGLE_TOKEN]);
    const watched = (async (input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal);
      return network.fetch(input, init);
    }) as typeof fetch;
    const services: Services = { db, settings: testSettings, fetch: watched, now: () => NOW, wait: async () => {} };
    await syncDueSites(services, FAR);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every(Boolean)).toBe(true);
  });
});

describe("index checks", () => {
  const PASSING: FakeRoute = { match: INSPECT, json: inspected("PASS", "Submitted and indexed") };

  /** A clock that moves when told, so a budget can run out the way it does for real. */
  function metered(routes: FakeRoute[], onCall: (url: string, clock: { now: number }) => void, onWait: (ms: number, clock: { now: number }) => void = () => {}) {
    const clock = { now: NOW.getTime() };
    const network = fakeFetch(routes);
    const fetchIt = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = await network.fetch(input, init);
      onCall(input.toString(), clock);
      return answer;
    }) as typeof fetch;
    const services: Services = { db, settings: testSettings, fetch: fetchIt, now: () => new Date(clock.now), wait: async (ms) => onWait(ms, clock) };
    return { services, calls: network.calls };
  }

  it("share a short budget across sites", async () => {
    const { workspaceId } = await googleSeat();
    for (const name of ["acme.example", "northwind.example", "third.example"]) {
      const one = await followSite(db, workspaceId, name);
      for (let index = 0; index < 5; index += 1) await storePage(db, workspaceId, one.id, `https://${name}/${index}`);
    }
    const deadline = NOW.getTime() + 60_000;
    let inspections = 0;
    const { services, calls } = metered([GOOGLE_TOKEN, PASSING], (url, clock) => {
      if (url.includes("urlInspection")) inspections += 1;
      if (inspections >= 3) clock.now = deadline;
    });
    await runIndexChecks(services, deadline);
    const hosts = calls.filter(({ url }) => url.includes("urlInspection")).map(({ body }) => new URL((JSON.parse(body) as { inspectionUrl: string }).inspectionUrl).hostname);
    expect(new Set(hosts).size).toBe(3);
  });

  it("don't let one property's quota eat the whole run", async () => {
    const { workspaceId } = await googleSeat();
    const limited = await followSite(db, workspaceId, "acme.example");
    const fine = await followSite(db, workspaceId, "northwind.example");
    await withWorkspace(db, workspaceId, (tx) => tx.insert(page).values(Array.from({ length: 100 }, (_, index) => ({ siteId: limited.id, url: `https://acme.example/${index}` }))));
    await withWorkspace(db, workspaceId, (tx) => tx.insert(page).values(Array.from({ length: 5 }, (_, index) => ({ siteId: fine.id, url: `https://northwind.example/${index}` }))));
    const routes: FakeRoute[] = [GOOGLE_TOKEN, { match: INSPECT, bodyHas: "sc-domain:acme.example", status: 429, json: { error: { message: "Quota exceeded" } } }, PASSING];
    const { services } = metered(routes, () => {}, (ms, clock) => {
      clock.now += ms;
    });
    const report = await runIndexChecks(services, NOW.getTime() + 270_000);
    expect(report.checked).toBeGreaterThan(0);
  });

  it("ask the account that has the site, when a workspace has two on Google", async () => {
    const seat = await createTestWorkspace(db);
    for (const name of ["ada", "bea"]) {
      const { services } = testServices(db, [{ ...GOOGLE_TOKEN, json: { access_token: "an-access-token", refresh_token: `token-of-${name}` } }, { ...GOOGLE_USER, json: { email: `${name}@acme.example` } }]);
      await connectGoogle(services, seat.workspaceId, seat.userId);
    }
    const one = await followSite(db, seat.workspaceId, "acme.example");
    await storePage(db, seat.workspaceId, one.id, "https://acme.example/pricing");
    const TOKEN = GOOGLE_TOKEN.match;
    const routes: FakeRoute[] = [
      { match: TOKEN, bodyHas: "refresh_token=token-of-ada", json: { access_token: "ada" } },
      { match: TOKEN, bodyHas: "refresh_token=token-of-bea", json: { access_token: "bea" } },
      { match: INSPECT, bearer: "ada", status: 403, json: { error: { message: "You do not own this site" } } },
      { match: INSPECT, bearer: "bea", json: inspected("PASS", "Submitted and indexed") },
    ];
    const { services } = testServices(db, routes);
    expect(await runIndexChecks(services, FAR)).toEqual({ checked: 1, failed: 0, left: 0 });
    expect((await inspectPage(services, seat.workspaceId, one.id, "https://acme.example/pricing")).ok).toBe(true);
  });

  it("submit a sitemap through the account that has the site", async () => {
    const seat = await createTestWorkspace(db);
    for (const name of ["ada", "bea"]) {
      const { services } = testServices(db, [{ ...GOOGLE_TOKEN, json: { access_token: "an-access-token", refresh_token: `token-of-${name}` } }, { ...GOOGLE_USER, json: { email: `${name}@acme.example` } }]);
      await connectGoogle(services, seat.workspaceId, seat.userId);
    }
    const one = await followSite(db, seat.workspaceId, "acme.example");
    const TOKEN = GOOGLE_TOKEN.match;
    const SITEMAPS = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(ACME)}/sitemaps`;
    const routes: FakeRoute[] = [
      { match: TOKEN, bodyHas: "refresh_token=token-of-ada", json: { access_token: "ada" } },
      { match: TOKEN, bodyHas: "refresh_token=token-of-bea", json: { access_token: "bea" } },
      { match: `PUT ${SITEMAPS}`, bearer: "ada", status: 403, json: { error: { message: "No access" } } },
      { match: `PUT ${SITEMAPS}`, bearer: "bea", json: {} },
      { match: `GET ${SITEMAPS}`, bearer: "bea", json: {} },
    ];
    const { services } = testServices(db, routes);
    expect((await submitSitemap(services, seat.workspaceId, seat.userId, one.id, "google", "https://acme.example/sitemap.xml")).ok).toBe(true);
  });
});

describe("adding sites", () => {
  it("still offers what a healthy account sees when another account's token has ended", async () => {
    const seat = await createTestWorkspace(db);
    await connectGoogle(testServices(db).services, seat.workspaceId, seat.userId);
    await connectBing(testServices(db).services, seat.workspaceId, seat.userId);
    const ended: FakeRoute = { match: GOOGLE_TOKEN.match, status: 400, json: { error: "invalid_grant", error_description: "Token has been expired or revoked." } };
    const { services } = testServices(db, [ended, BING_SITES]);
    await expect(sitesAvailable(services, seat.workspaceId)).resolves.toMatchObject([{ domain: "acme.example" }]);
    expect((await addSites(services, seat.workspaceId, seat.userId, ["acme.example"])).ok).toBe(true);
  });

  it("reads the property for the whole site, not whichever Google listed last", async () => {
    const { workspaceId } = await googleSeat();
    const { services } = testServices(db, [GOOGLE_TOKEN, googleSites("https://acme.example/", "https://acme.example/blog/")]);
    expect((await sitesAvailable(services, workspaceId))[0].googleProperty).toBe("https://acme.example/");
  });

  it("prefers the https property to a legacy http one listed after it", async () => {
    const { workspaceId } = await googleSeat();
    const { services } = testServices(db, [GOOGLE_TOKEN, googleSites("https://acme.example/", "http://acme.example/")]);
    expect((await sitesAvailable(services, workspaceId))[0].googleProperty).toBe("https://acme.example/");
  });
});

describe("someone taken out of a workspace", () => {
  it("loses the read access of the API key they made", async () => {
    const { workspaceId, userId } = await googleSeat();
    const admin = await teammate(db, workspaceId, "admin");
    const made = await createApiKey(db, workspaceId, admin, "Mine", ["figures:read"]);
    if (!made.ok) throw new Error(made.error);
    expect((await removeMember(db, workspaceId, userId, admin)).ok).toBe(true);
    expect((await accessOfKey(db, made.key, "figures:read")).status).not.toBe("ok");
  });
});
