import { and, desc, eq, gte, lt, lte, or, sql } from "drizzle-orm";
import { isDecaying, type Figures, type PeriodClicks } from "@/domain/search";
import type { Database } from "@/infrastructure/db/client";
import { page, pageDay, site } from "@/infrastructure/db/schema/search";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { comparedDays, figuresSql, inComparedDays, onCompared, onSites, type SiteScope } from "./search-columns";
import { wholeDaysUpTo, type Period } from "./time-range";

export interface PageFigures extends Figures {
  url: string;
  siteId: string;
  siteName: string;
}

const DEFAULT_LIMIT = 100;
const COMPARED_DAYS = 28;
const MOST_DECAYING = 50;

/** The pages search brought people to, the most clicked first. */
export function pagesOf(db: Database, workspaceId: string, { sites, period, limit = DEFAULT_LIMIT }: { sites: SiteScope; period: Pick<Period, "from" | "to">; limit?: number }): Promise<PageFigures[]> {
  return withWorkspace(db, workspaceId, (tx) =>
    tx
      .select({ url: page.url, siteId: site.id, siteName: site.name, ...figuresSql(pageDay) })
      .from(pageDay)
      .innerJoin(page, eq(page.id, pageDay.pageId))
      .innerJoin(site, eq(site.id, pageDay.siteId))
      .where(and(onSites(pageDay.siteId, sites), gte(pageDay.day, period.from), lte(pageDay.day, period.to)))
      .groupBy(page.url, site.id, site.name)
      .orderBy(desc(sql`sum(${pageDay.clicks})`), page.url)
      .limit(limit),
  );
}

export interface DecayingPage extends PeriodClicks {
  url: string;
  siteId: string;
  siteName: string;
  lost: number;
  shareLost: number;
}

/** Pages that had real traffic and lost a good part of it: the last four weeks against the four before, the biggest loss first. Today is left out, and the four weeks before stop where each site has reported up to: engines report late. */
export async function decayingPagesOf(db: Database, workspaceId: string, sites: SiteScope, now: Date): Promise<DecayingPage[]> {
  const compared = wholeDaysUpTo(now, COMPARED_DAYS);
  const rows = await withWorkspace(db, workspaceId, (tx) => {
    const days = comparedDays(tx, pageDay, compared);
    return tx
      .select({
        url: page.url,
        siteId: site.id,
        siteName: site.name,
        clicks: sql<number>`coalesce(sum(${pageDay.clicks}) filter (where ${pageDay.day} >= ${compared.from}), 0)::float8`,
        clicksBefore: sql<number>`coalesce(sum(${pageDay.clicks}) filter (where ${lt(pageDay.day, compared.from)}), 0)::float8`,
      })
      .from(pageDay)
      .innerJoin(page, eq(page.id, pageDay.pageId))
      .innerJoin(site, eq(site.id, pageDay.siteId))
      .innerJoin(days, onCompared(pageDay, days))
      .where(and(onSites(pageDay.siteId, sites), or(and(gte(pageDay.day, compared.from), lte(pageDay.day, compared.to)), inComparedDays(pageDay.day, days))))
      .groupBy(page.url, site.id, site.name);
  });
  return rows
    .filter(isDecaying)
    .map((row) => ({ ...row, lost: row.clicksBefore - row.clicks, shareLost: (row.clicksBefore - row.clicks) / row.clicksBefore }))
    .sort((a, b) => b.lost - a.lost || a.url.localeCompare(b.url))
    .slice(0, MOST_DECAYING);
}
