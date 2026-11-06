import { and, eq, gte, lte, sql } from "drizzle-orm";
import { combined, RANK_BANDS, rankBandOf, type Figures, type RankBand } from "@/domain/search";
import type { Database } from "@/infrastructure/db/client";
import { keyword, keywordDay, searchDay, site, trackedKeyword } from "@/infrastructure/db/schema/search";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { comparedDays, figuresSql, inComparedDays, onCompared, onSites, type SiteScope } from "./search-columns";
import type { Period } from "./time-range";

export interface SiteCard extends Figures {
  siteId: string;
  name: string;
  clicksBefore: number;
  lastSyncedAt: Date | null;
  lastSyncError: string | null;
  /** Clicks on each day of the period, oldest first. */
  spark: number[];
  keywords: number;
  tracked: number;
  bands: Record<RankBand, number>;
}

const noBands = () => Object.fromEntries(RANK_BANDS.map((band) => [band, 0])) as Record<RankBand, number>;

/** A row per engine per day, not added up per day: that would weigh one engine's position by the other's impressions. */
function siteDays(tx: Database, { from, to }: Pick<Period, "from" | "to">) {
  return tx.select({ siteId: searchDay.siteId, day: searchDay.day, clicks: searchDay.clicks, impressions: searchDay.impressions, position: searchDay.position }).from(searchDay).where(and(gte(searchDay.day, from), lte(searchDay.day, to)));
}

/** Each site's clicks in the time before a period, as far as it has reported this one. */
function clicksBeforeBySite(tx: Database, period: Period) {
  const compared = comparedDays(tx, searchDay, period);
  return tx
    .select({ siteId: searchDay.siteId, clicks: sql<number>`coalesce(sum(${searchDay.clicks}), 0)::float8` })
    .from(searchDay)
    .innerJoin(compared, onCompared(searchDay, compared))
    .where(inComparedDays(searchDay.day, compared))
    .groupBy(searchDay.siteId);
}

function clicksPerDay(rows: readonly { day: string; clicks: number }[]): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const { day, clicks } of rows) byDay.set(day, (byDay.get(day) ?? 0) + clicks);
  return byDay;
}

function keywordPositions(tx: Database, { from, to }: Pick<Period, "from" | "to">) {
  return tx
    .select({ siteId: keywordDay.siteId, keywordId: keywordDay.keywordId, ...figuresSql(keywordDay) })
    .from(keywordDay)
    .innerJoin(keyword, eq(keyword.id, keywordDay.keywordId))
    .where(and(gte(keywordDay.day, from), lte(keywordDay.day, to)))
    .groupBy(keywordDay.siteId, keywordDay.keywordId);
}

const trackedCounts = (tx: Database) => tx.select({ siteId: trackedKeyword.siteId, count: sql<number>`count(*)::int` }).from(trackedKeyword).groupBy(trackedKeyword.siteId);

/** Where each of a site's keywords ranks, and how many there are. */
function bandsBySite(rows: { siteId: string; position: number | null }[]): Map<string, { keywords: number; bands: Record<RankBand, number> }> {
  const bySite = new Map<string, { keywords: number; bands: Record<RankBand, number> }>();
  for (const { siteId, position } of rows) {
    const entry = bySite.get(siteId) ?? { keywords: 0, bands: noBands() };
    entry.keywords += 1;
    if (position !== null) entry.bands[rankBandOf(position)] += 1;
    bySite.set(siteId, entry);
  }
  return bySite;
}

/** A card per site, the most clicked first: enough to see at a glance which are moving. */
export async function siteCardsOf(db: Database, workspaceId: string, period: Period, scope: SiteScope = null): Promise<SiteCard[]> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [sites, days, before, positions, tracked] = [await tx.select().from(site).where(onSites(site.id, scope)), await siteDays(tx, period), await clicksBeforeBySite(tx, period), await keywordPositions(tx, period), await trackedCounts(tx)];
    const bands = bandsBySite(positions);
    const clicksBefore = new Map(before.map(({ siteId, clicks }) => [siteId, clicks]));
    const trackedBy = new Map(tracked.map(({ siteId, count }) => [siteId, count]));
    return sites
      .map((one) => {
        const mine = days.filter(({ siteId }) => siteId === one.id);
        const byDay = clicksPerDay(mine);
        return {
          siteId: one.id,
          name: one.name,
          lastSyncedAt: one.lastSyncedAt,
          lastSyncError: one.lastSyncError,
          ...combined(mine),
          clicksBefore: clicksBefore.get(one.id) ?? 0,
          spark: period.days.map((day) => byDay.get(day) ?? 0),
          keywords: bands.get(one.id)?.keywords ?? 0,
          tracked: trackedBy.get(one.id) ?? 0,
          bands: bands.get(one.id)?.bands ?? noBands(),
        };
      })
      .sort((a, b) => b.clicks - a.clicks || a.name.localeCompare(b.name));
  });
}
