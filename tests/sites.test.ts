import { eq } from "drizzle-orm";
import { connectionsOf } from "@/application/connections";
import { beforeAll, describe, expect, it } from "vitest";
import type { Services } from "@/application/services";
import { addSites, isUuid, propertyFor, removeSite, siteIn, sitesAvailable, sitesOf } from "@/application/sites";
import { NOT_A_MANAGER_OF_SETTINGS } from "@/domain/team";
import { domainOf } from "@/infrastructure/connectors/google";
import type { Database } from "@/infrastructure/db/client";
import { indexCheck, keyword, keywordDay, page, pageDay, searchDay, site, sitemap, trackedKeyword } from "@/infrastructure/db/schema/search";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import type { FakeRoute } from "./support/fetch";
import { BING_SITES, bingSites, connectBing, connectGoogle, followSite, GOOGLE_SITES, GOOGLE_TOKEN, googleSites, storeKeyword, storePage, storeTotals, teammate, testServices } from "./support/search";

let db: Database;
let services: Services;
beforeAll(async () => {
  db = await createTestDatabase();
  services = testServices(db).services;
});

/** A workspace with both accounts connected. */
async function connected() {
  const seat = await createTestWorkspace(db);
  await connectGoogle(services, seat.workspaceId, seat.userId);
  await connectBing(services, seat.workspaceId, seat.userId);
  return seat;
}

const seeing = (...routes: FakeRoute[]) => testServices(db, routes).services;

describe("what's available", () => {
  it("is nothing without a connection", async () => {
    const { workspaceId } = await createTestWorkspace(db);
    expect(await sitesAvailable(services, workspaceId)).toEqual([]);
  });

  it("merges one domain across engines, however each writes it", async () => {
    const { workspaceId } = await connected();
    expect(await sitesAvailable(services, workspaceId)).toEqual([{ domain: "acme.example", googleProperty: "sc-domain:acme.example", bingSite: "https://www.acme.example/", added: false }]);
  });

  it.each([
    ["the domain property first", ["sc-domain:acme.example", "https://www.acme.example/"]],
    ["the URL property first", ["https://www.acme.example/", "sc-domain:acme.example"]],
  ])("prefers a domain property to a URL property, with %s", async (_order, properties) => {
    const { workspaceId } = await connected();
    expect(await sitesAvailable(seeing(GOOGLE_TOKEN, googleSites(...properties), BING_SITES), workspaceId)).toMatchObject([{ domain: "acme.example", googleProperty: "sc-domain:acme.example" }]);
  });

  it("lists each domain once, in order", async () => {
    const { workspaceId } = await connected();
    const available = await sitesAvailable(seeing(GOOGLE_TOKEN, googleSites("sc-domain:northwind.example", "sc-domain:acme.example"), bingSites("https://blog.northwind.example/", "https://northwind.example/")), workspaceId);
    expect(available).toEqual([
      { domain: "acme.example", googleProperty: "sc-domain:acme.example", bingSite: null, added: false },
      { domain: "blog.northwind.example", googleProperty: null, bingSite: "https://blog.northwind.example/", added: false },
      { domain: "northwind.example", googleProperty: "sc-domain:northwind.example", bingSite: "https://northwind.example/", added: false },
    ]);
  });

  it("leaves out a property Google says this account hasn't verified", async () => {
    const { workspaceId } = await connected();
    const unverified = { match: GOOGLE_SITES.match, json: { siteEntry: [{ siteUrl: "sc-domain:acme.example", permissionLevel: "siteUnverifiedUser" }] } };
    expect(await sitesAvailable(seeing(GOOGLE_TOKEN, unverified, bingSites()), workspaceId)).toEqual([]);
  });

  it("says which are already added", async () => {
    const { workspaceId, userId } = await connected();
    const twoSites = seeing(GOOGLE_TOKEN, googleSites("sc-domain:acme.example", "sc-domain:northwind.example"), bingSites());
    await addSites(twoSites, workspaceId, userId, ["acme.example"]);
    expect((await sitesAvailable(twoSites, workspaceId)).map(({ domain, added }) => [domain, added])).toEqual([["acme.example", true], ["northwind.example", false]]);
  });

  it("isn't added yet on an engine connected since: there's still something to add", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    await connectGoogle(services, workspaceId, userId);
    await addSites(services, workspaceId, userId, ["acme.example"]);
    expect(await sitesAvailable(services, workspaceId)).toMatchObject([{ added: true }]);
    await connectBing(services, workspaceId, userId);
    expect(await sitesAvailable(services, workspaceId)).toMatchObject([{ bingSite: "https://www.acme.example/", added: false }]);
  });
});

describe("a domain", () => {
  it.each([
    ["sc-domain:acme.example", "acme.example"],
    ["sc-domain:www.acme.example", "acme.example"],
    ["https://www.acme.example/", "acme.example"],
    ["https://blog.acme.example/fr/", "blog.acme.example"],
    ["http://acme.example", "acme.example"],
    ["www.not a host", "not a host"],
  ])("is what %s comes to", (property, domain) => {
    expect(domainOf(property)).toBe(domain);
  });
});

describe("adding a site", () => {
  it("follows it under what each engine calls it, ready for the next sync", async () => {
    const { workspaceId, userId } = await connected();
    expect(await addSites(services, workspaceId, userId, ["acme.example"])).toEqual({ ok: true, said: "Added acme.example. Its figures arrive with the next sync." });
    expect(await sitesOf(db, workspaceId)).toMatchObject([{ name: "acme.example", googleProperty: "sc-domain:acme.example", bingSite: "https://www.acme.example/", lastSyncedAt: null }]);
  });

  it("says how many when there are several", async () => {
    const { workspaceId, userId } = await connected();
    const twoSites = seeing(GOOGLE_TOKEN, googleSites("sc-domain:acme.example", "sc-domain:northwind.example"), bingSites());
    expect(await addSites(twoSites, workspaceId, userId, ["acme.example", "northwind.example"])).toEqual({ ok: true, said: "Added 2 sites. Their figures arrive with the next sync." });
    expect((await sitesOf(db, workspaceId)).map(({ name }) => name)).toEqual(["acme.example", "northwind.example"]);
  });

  it("twice doesn't duplicate it", async () => {
    const { workspaceId, userId } = await connected();
    await addSites(services, workspaceId, userId, ["acme.example"]);
    await addSites(services, workspaceId, userId, ["acme.example"]);
    expect(await sitesOf(db, workspaceId)).toHaveLength(1);
  });

  it("gives a site already followed the engine it was missing, and a first read for it", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    await connectGoogle(services, workspaceId, userId);
    await addSites(services, workspaceId, userId, ["acme.example"]);
    await withWorkspace(db, workspaceId, (tx) => tx.update(site).set({ lastSyncedAt: new Date() }));
    await connectBing(services, workspaceId, userId);
    await addSites(services, workspaceId, userId, ["acme.example"]);
    expect(await sitesOf(db, workspaceId)).toMatchObject([{ googleProperty: "sc-domain:acme.example", bingSite: "https://www.acme.example/", lastSyncedAt: null }]);
  });

  it("doesn't lose an engine whose account is away when it's added again", async () => {
    const { workspaceId, userId } = await connected();
    await addSites(services, workspaceId, userId, ["acme.example"]);
    await addSites(seeing(GOOGLE_TOKEN, GOOGLE_SITES, bingSites()), workspaceId, userId, ["acme.example"]);
    expect(await sitesOf(db, workspaceId)).toMatchObject([{ googleProperty: "sc-domain:acme.example", bingSite: "https://www.acme.example/" }]);
  });

  it("refuses a domain no connected account can see, and adds nothing", async () => {
    const { workspaceId, userId } = await connected();
    expect(await addSites(services, workspaceId, userId, ["northwind.example"])).toEqual({ ok: false, error: "None of your connected accounts can see that site." });
    expect(await addSites(services, workspaceId, userId, [])).toMatchObject({ ok: false });
    expect(await sitesOf(db, workspaceId)).toEqual([]);
  });

  it("says when every engine refuses, rather than failing on the screen", async () => {
    const { workspaceId, userId } = await connected();
    const refusing = seeing(GOOGLE_TOKEN, { ...GOOGLE_SITES, status: 401, json: { error: { message: "Token ended" } } }, { ...BING_SITES, status: 401, json: { message: "Key ended" } });
    expect(await addSites(refusing, workspaceId, userId, ["acme.example"])).toEqual({ ok: false, error: "Google refused the credentials: Token ended" });
    expect(await sitesOf(db, workspaceId)).toEqual([]);
  });

  it("goes on with what the others see when one engine refuses, saying so on its connection", async () => {
    const { workspaceId, userId } = await connected();
    const refusing = seeing(GOOGLE_TOKEN, GOOGLE_SITES, { ...BING_SITES, status: 401, json: { message: "Key ended" } });
    expect((await addSites(refusing, workspaceId, userId, ["acme.example"])).ok).toBe(true);
    expect((await connectionsOf(refusing, workspaceId)).find(({ kind }) => kind === "bing")).toMatchObject({ status: "failing", lastError: "Bing refused the credentials: Key ended" });
  });

  it("is for those who manage the workspace", async () => {
    const { workspaceId } = await connected();
    const { userId: outsider } = await createTestWorkspace(db, "Elsewhere");
    for (const asker of [await teammate(db, workspaceId), outsider]) expect(await addSites(services, workspaceId, asker, ["acme.example"])).toEqual({ ok: false, error: NOT_A_MANAGER_OF_SETTINGS });
    expect(await sitesOf(db, workspaceId)).toEqual([]);
  });

  it("stays in its workspace: the same domain can be followed by two companies", async () => {
    const mine = await connected();
    const theirs = await connected();
    await addSites(services, mine.workspaceId, mine.userId, ["acme.example"]);
    expect(await sitesOf(db, theirs.workspaceId)).toEqual([]);
    expect(await sitesAvailable(services, theirs.workspaceId)).toMatchObject([{ added: false }]);
    expect((await addSites(services, theirs.workspaceId, theirs.userId, ["acme.example"])).ok).toBe(true);
  });
});

describe("removing a site", () => {
  const DAY = { day: "2026-11-01", clicks: 1, impressions: 10, position: 5 };

  /** A site with a row in every table that can hold something about it. */
  async function stocked() {
    const seat = await createTestWorkspace(db);
    const row = await followSite(db, seat.workspaceId);
    await storeTotals(db, seat.workspaceId, row.id, "google", [DAY]);
    const keywordId = await storeKeyword(db, seat.workspaceId, row.id, "acme pricing", [DAY]);
    const pageId = await storePage(db, seat.workspaceId, row.id, "https://acme.example/pricing", [DAY]);
    await withWorkspace(db, seat.workspaceId, async (tx) => {
      await tx.insert(trackedKeyword).values({ siteId: row.id, keywordId });
      await tx.insert(indexCheck).values({ siteId: row.id, pageId, day: DAY.day, verdict: "PASS" });
      await tx.insert(sitemap).values({ siteId: row.id, engine: "google", url: "https://acme.example/sitemap.xml" });
    });
    return { ...seat, row };
  }

  const STORED = [searchDay, keyword, keywordDay, page, pageDay, trackedKeyword, indexCheck, sitemap];
  const countsFor = (workspaceId: string, siteId: string) => withWorkspace(db, workspaceId, async (tx) => Promise.all(STORED.map(async (table) => (await tx.select().from(table).where(eq(table.siteId, siteId))).length)));

  it("forgets everything stored about it", async () => {
    const { workspaceId, userId, row } = await stocked();
    expect(await countsFor(workspaceId, row.id)).toEqual(STORED.map(() => 1));
    expect(await removeSite(services, workspaceId, userId, row.id)).toEqual({ ok: true, said: "Removed acme.example and what was stored about it." });
    expect(await sitesOf(db, workspaceId)).toEqual([]);
    expect(await countsFor(workspaceId, row.id)).toEqual(STORED.map(() => 0));
  });

  it("leaves its other sites alone", async () => {
    const { workspaceId, userId, row } = await stocked();
    const other = await followSite(db, workspaceId, "northwind.example");
    await storeTotals(db, workspaceId, other.id, "google", [DAY]);
    await removeSite(services, workspaceId, userId, row.id);
    expect((await sitesOf(db, workspaceId)).map(({ name }) => name)).toEqual(["northwind.example"]);
    expect((await withWorkspace(db, workspaceId, (tx) => tx.select().from(searchDay))).map(({ siteId }) => siteId)).toEqual([other.id]);
  });

  it("is for those who manage the workspace", async () => {
    const { workspaceId, row } = await stocked();
    expect(await removeSite(services, workspaceId, await teammate(db, workspaceId), row.id)).toEqual({ ok: false, error: NOT_A_MANAGER_OF_SETTINGS });
    expect(await countsFor(workspaceId, row.id)).toEqual(STORED.map(() => 1));
  });

  it("doesn't find another workspace's site, or one that was never there, and removes nothing", async () => {
    const mine = await createTestWorkspace(db);
    const theirs = await stocked();
    const none = { ok: false, error: "There’s no such site here." };
    expect(await removeSite(services, mine.workspaceId, mine.userId, theirs.row.id)).toEqual(none);
    expect(await removeSite(services, mine.workspaceId, mine.userId, crypto.randomUUID())).toEqual(none);
    expect(await removeSite(services, mine.workspaceId, mine.userId, "not-an-id")).toEqual(none);
    expect(await countsFor(theirs.workspaceId, theirs.row.id)).toEqual(STORED.map(() => 1));
  });
});

describe("a workspace's sites", () => {
  it("are found by their id, and only there", async () => {
    const mine = await createTestWorkspace(db);
    const theirs = await createTestWorkspace(db, "Theirs");
    const row = await followSite(db, mine.workspaceId);
    expect(await siteIn(db, mine.workspaceId, row.id)).toMatchObject({ id: row.id, name: "acme.example" });
    expect(await siteIn(db, theirs.workspaceId, row.id)).toBeUndefined();
  });

  it("aren't looked for when what's given can't be an id", async () => {
    const { workspaceId } = await createTestWorkspace(db);
    expect(isUuid("not-an-id")).toBe(false);
    expect(isUuid("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(await siteIn(db, workspaceId, "not-an-id")).toBeUndefined();
  });

  it("say what each engine calls them", () => {
    const row = { googleProperty: "sc-domain:acme.example", bingSite: null };
    expect(propertyFor(row, "google")).toBe("sc-domain:acme.example");
    expect(propertyFor(row, "bing")).toBeNull();
  });

  it("are listed by name", async () => {
    const { workspaceId } = await createTestWorkspace(db);
    await followSite(db, workspaceId, "northwind.example");
    await followSite(db, workspaceId, "acme.example");
    expect((await sitesOf(db, workspaceId)).map(({ name }) => name)).toEqual(["acme.example", "northwind.example"]);
  });
});
