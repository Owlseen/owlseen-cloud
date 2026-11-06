import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { alertsOf, pagesDroppedOf } from "@/application/alerts";
import { movedKeywordsOf } from "@/application/keywords";
import { overviewOf } from "@/application/overview";
import { siteCardsOf } from "@/application/site-cards";
import { periodEndingAt } from "@/application/time-range";
import type { Database } from "@/infrastructure/db/client";
import { indexCheck, keyword, site, siteGroup, siteGroupMember } from "@/infrastructure/db/schema/search";
import { member, workspace } from "@/infrastructure/db/schema/tenancy";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { followSite, NOW, storeKeyword, storePage, storeTotals } from "./support/search";

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
}, 400_000);

const WEEK = periodEndingAt(NOW, 7);
/** 2026-10-(from) to 2026-10-(to), counting on past 31 into November, at this many clicks a day. */
const steady = (from: number, to: number, clicks = 10) => Array.from({ length: to - from + 1 }, (_, index) => ({ day: new Date(Date.UTC(2026, 9, from + index)).toISOString().slice(0, 10), clicks, impressions: clicks * 10, position: 5 }));

describe("what's compared stops where this site has reported", () => {
  it("doesn't alert about a steady site whose reads stopped, because another site in the workspace is fresh", async () => {
    const { workspaceId } = await createTestWorkspace(db);
    const fresh = await followSite(db, workspaceId, "acme.example");
    const stale = await followSite(db, workspaceId, "northwind.example");
    await storeTotals(db, workspaceId, fresh.id, "google", steady(15, 35));
    await storeTotals(db, workspaceId, stale.id, "google", steady(15, 29));
    expect((await alertsOf(db, workspaceId, null, NOW)).filter(({ siteName }) => siteName === "northwind.example")).toEqual([]);
  });

  it("cuts one site's overview at that site's last day, not the workspace's", async () => {
    const { workspaceId } = await createTestWorkspace(db);
    const fresh = await followSite(db, workspaceId, "acme.example");
    const stale = await followSite(db, workspaceId, "northwind.example");
    await storeTotals(db, workspaceId, fresh.id, "google", steady(15, 35));
    await storeTotals(db, workspaceId, stale.id, "google", steady(15, 31));
    const { totals, totalsBefore } = await overviewOf(db, workspaceId, { sites: stale.id, period: WEEK });
    expect(totals.clicks).toBe(20);
    expect(totalsBefore.clicks).toBe(20);
  });

  it("does the same on a site's card", async () => {
    const { workspaceId } = await createTestWorkspace(db);
    const fresh = await followSite(db, workspaceId, "acme.example");
    const stale = await followSite(db, workspaceId, "northwind.example");
    await storeTotals(db, workspaceId, fresh.id, "google", steady(15, 35));
    await storeTotals(db, workspaceId, stale.id, "google", steady(15, 31));
    expect((await siteCardsOf(db, workspaceId, WEEK, stale.id))[0]).toMatchObject({ clicks: 20, clicksBefore: 20 });
  });
});

describe("an engine with nothing reported in the period counts on neither side", () => {
  it("doesn't alert when Bing's reads stopped a week ago and Google is steady", async () => {
    const { workspaceId } = await createTestWorkspace(db);
    const one = await followSite(db, workspaceId, "acme.example", { bingSite: "https://www.acme.example/" });
    await storeTotals(db, workspaceId, one.id, "google", steady(15, 35));
    await storeTotals(db, workspaceId, one.id, "bing", steady(15, 28, 10).map((day) => ({ ...day, position: null })));
    expect(await alertsOf(db, workspaceId, one.id, NOW)).toEqual([]);
  });
});

describe("a day that has just begun", () => {

  it("doesn't make a steady site read as falling on a week ending today", async () => {
    const { workspaceId } = await createTestWorkspace(db);
    const one = await followSite(db, workspaceId, "acme.example");
    await storeTotals(db, workspaceId, one.id, "google", steady(15, 35, 100));
    // Today's first row, as dataState "all" returns it: an hour of data at most, read at 09:00 UTC (01:00 in Pacific time).
    await storeTotals(db, workspaceId, one.id, "google", [{ day: "2026-11-05", clicks: 1, impressions: 10, position: 5 }]);
    const { totals, totalsBefore } = await overviewOf(db, workspaceId, { sites: one.id, period: WEEK });
    const change = (totals.clicks - totalsBefore.clicks) / totalsBefore.clicks;
    expect(Math.abs(change)).toBeLessThan(0.05);
  });
});

describe("'found out of the index this week'", () => {
  it("doesn't say so of a page that left in August and is simply checked again each week", async () => {
    const { workspaceId } = await createTestWorkspace(db);
    const one = await followSite(db, workspaceId, "acme.example");
    const pageId = await storePage(db, workspaceId, one.id, "https://acme.example/gone");
    const checks = [{ day: "2026-08-01", verdict: "PASS" }, ...["2026-08-08", "2026-08-15", "2026-09-05", "2026-10-03", "2026-11-01"].map((day) => ({ day, verdict: "NEUTRAL" }))];
    await withWorkspace(db, workspaceId, (tx) => tx.insert(indexCheck).values(checks.map((check) => ({ siteId: one.id, pageId, ...check }))));
    expect(await pagesDroppedOf(db, workspaceId, null, NOW)).toEqual([]);
  });
});

describe("the keywords page", () => {
  it("applies the words typed to what moved, like its other tabs", async () => {
    const { workspaceId } = await createTestWorkspace(db);
    const one = await followSite(db, workspaceId, "acme.example");
    await storeKeyword(db, workspaceId, one.id, "alpha", steady(23, 29, 20));
    await storeKeyword(db, workspaceId, one.id, "beta", steady(23, 29, 20));
    await storeKeyword(db, workspaceId, one.id, "reported up to the 3rd", steady(34, 34, 1));
    // As app/keywords/page.tsx passes it: `asked` holds `search`.
    const asked = { sites: one.id, period: WEEK, search: "alpha" };
    const moved = await movedKeywordsOf(db, workspaceId, asked);
    expect(moved.map(({ text }) => text)).toEqual(["alpha"]);
  });
});

describe("big numbers", () => {
  it("adds up more than 2.1 billion impressions without failing", async () => {
    const { workspaceId } = await createTestWorkspace(db);
    const one = await followSite(db, workspaceId, "acme.example");
    await storeTotals(db, workspaceId, one.id, "google", [
      { day: "2026-11-01", clicks: 1, impressions: 2_000_000_000, position: 5 },
      { day: "2026-11-02", clicks: 1, impressions: 2_000_000_000, position: 5 },
    ]);
    await expect(overviewOf(db, workspaceId, { sites: one.id, period: WEEK })).resolves.toBeTruthy();
  });
});

describe("what the schema itself refuses (defence in depth)", () => {
  it("has row-level security on every table with workspace_id, not forced on its owner, as docs/00-product.md says", async () => {
    const { rows } = (await db.execute(sql`select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_attribute a on a.attrelid = c.oid where a.attname = 'workspace_id' and c.relkind = 'r'`)) as unknown as { rows: { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[] };
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.filter(({ relrowsecurity }) => !relrowsecurity).map(({ relname }) => relname)).toEqual([]);
    expect(rows.filter(({ relforcerowsecurity }) => relforcerowsecurity).map(({ relname }) => relname)).toEqual([]);
  });

  it("doesn't show the app role every workspace's name, inside a workspace's scope", async () => {
    const mine = await createTestWorkspace(db, "Mine");
    await createTestWorkspace(db, "Theirs");
    const seen = await withWorkspace(db, mine.workspaceId, (tx) => tx.select({ id: workspace.id }).from(workspace));
    expect(seen.map(({ id }) => id)).toEqual([mine.workspaceId]);
  });

  it("doesn't show the app role every workspace's members, inside a workspace's scope", async () => {
    const mine = await createTestWorkspace(db, "Mine");
    await createTestWorkspace(db, "Theirs");
    const seen = await withWorkspace(db, mine.workspaceId, (tx) => tx.select({ workspaceId: member.workspaceId }).from(member));
    expect(seen.every(({ workspaceId }) => workspaceId === mine.workspaceId)).toBe(true);
  });

  it("refuses a row of one workspace pointing at another's site", async () => {
    const mine = await createTestWorkspace(db, "Mine");
    const theirs = await createTestWorkspace(db, "Theirs");
    const theirSite = await followSite(db, theirs.workspaceId, "northwind.example");
    await expect(withWorkspace(db, mine.workspaceId, (tx) => tx.insert(keyword).values({ siteId: theirSite.id, text: "planted" }))).rejects.toThrow();
  });

  it("refuses a group of one workspace holding another's site", async () => {
    const mine = await createTestWorkspace(db, "Mine");
    const theirs = await createTestWorkspace(db, "Theirs");
    const theirSite = await followSite(db, theirs.workspaceId, "northwind.example");
    await expect(
      withWorkspace(db, mine.workspaceId, async (tx) => {
        const [group] = await tx.insert(siteGroup).values({ name: "Mine" }).returning({ id: siteGroup.id });
        await tx.insert(siteGroupMember).values({ groupId: group.id, siteId: theirSite.id });
      }),
    ).rejects.toThrow();
  });

  it("RLS still hides their site's rows from such a planted reference", async () => {
    const mine = await createTestWorkspace(db, "Mine");
    const theirs = await createTestWorkspace(db, "Theirs");
    const theirSite = await followSite(db, theirs.workspaceId, "northwind.example");
    const seen = await withWorkspace(db, mine.workspaceId, (tx) => tx.select({ id: site.id }).from(site));
    expect(seen.map(({ id }) => id)).not.toContain(theirSite.id);
  });
});
