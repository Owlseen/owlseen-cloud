import { and, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { moveOf, opportunityOf, type Figures, type KeywordMove, type Opportunity } from "@/domain/search";
import type { Database } from "@/infrastructure/db/client";
import { keyword, keywordDay, site } from "@/infrastructure/db/schema/search";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { comparedDays, figuresSql, inComparedDays, onCompared, onSites, type SiteScope } from "./search-columns";
import type { Period } from "./time-range";

export interface KeywordFigures extends Figures {
  id: number;
  text: string;
  siteId: string;
  siteName: string;
}

export interface KeywordQuery {
  sites: SiteScope;
  period: Pick<Period, "from" | "to">;
  limit?: number;
  /** Part of the words. */
  search?: string;
}

const DEFAULT_LIMIT = 100;
/** Enough to find what's worth working on, taken by how often they're shown: the point is what hasn't been clicked yet. */
const MOST_CONSIDERED = 5_000;

const escapedLike = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

function keywordRows(tx: Database, { sites, period, search }: KeywordQuery, limit: number, mostFirst: "clicks" | "impressions" = "clicks") {
  return tx
    .select({ id: keyword.id, text: keyword.text, siteId: site.id, siteName: site.name, ...figuresSql(keywordDay) })
    .from(keywordDay)
    .innerJoin(keyword, eq(keyword.id, keywordDay.keywordId))
    .innerJoin(site, eq(site.id, keywordDay.siteId))
    .where(and(onSites(keywordDay.siteId, sites), gte(keywordDay.day, period.from), lte(keywordDay.day, period.to), search ? ilike(keyword.text, escapedLike(search)) : undefined))
    .groupBy(keyword.id, keyword.text, site.id, site.name)
    .orderBy(...(mostFirst === "clicks" ? [desc(sql`sum(${keywordDay.clicks})`), desc(sql`sum(${keywordDay.impressions})`)] : [desc(sql`sum(${keywordDay.impressions})`)]), keyword.text)
    .limit(limit);
}

/** What people searched to find these sites, the most clicked first. */
export function keywordsOf(db: Database, workspaceId: string, query: KeywordQuery): Promise<KeywordFigures[]> {
  return withWorkspace(db, workspaceId, (tx) => keywordRows(tx, query, query.limit ?? DEFAULT_LIMIT));
}

export type KeywordOpportunity = KeywordFigures & Opportunity;

/** Keywords just off the first page or on the second, the most clicks to win first. */
export async function opportunitiesOf(db: Database, workspaceId: string, query: KeywordQuery): Promise<KeywordOpportunity[]> {
  const rows = await withWorkspace(db, workspaceId, (tx) => keywordRows(tx, query, MOST_CONSIDERED, "impressions"));
  const found = rows.flatMap((row) => {
    const opportunity = opportunityOf(row);
    return opportunity ? [{ ...row, ...opportunity }] : [];
  });
  return found.sort((a, b) => b.potential - a.potential || b.impressions - a.impressions).slice(0, query.limit ?? DEFAULT_LIMIT);
}

export interface MovedKeyword extends KeywordMove {
  id: number;
  text: string;
  siteId: string;
  siteName: string;
}

const MOST_MOVED = 100;

/** Keywords whose clicks moved a lot against the time just before, as far as Search Console has reported this period for each site, the biggest move first. */
export async function movedKeywordsOf(db: Database, workspaceId: string, { sites, period, limit = MOST_MOVED, search }: { sites: SiteScope; period: Period; limit?: number; search?: string }): Promise<MovedKeyword[]> {
  const rows = await withWorkspace(db, workspaceId, (tx) => {
    const compared = comparedDays(tx, keywordDay, period);
    return tx
      .select({
        id: keyword.id,
        text: keyword.text,
        siteId: site.id,
        siteName: site.name,
        clicks: sql<number>`coalesce(sum(${keywordDay.clicks}) filter (where ${keywordDay.day} >= ${period.from}), 0)::float8`,
        clicksBefore: sql<number>`coalesce(sum(${keywordDay.clicks}) filter (where ${keywordDay.day} < ${period.from}), 0)::float8`,
      })
      .from(keywordDay)
      .innerJoin(keyword, eq(keyword.id, keywordDay.keywordId))
      .innerJoin(site, eq(site.id, keywordDay.siteId))
      .innerJoin(compared, onCompared(keywordDay, compared))
      .where(and(onSites(keywordDay.siteId, sites), search ? ilike(keyword.text, escapedLike(search)) : undefined, or(and(gte(keywordDay.day, period.from), lte(keywordDay.day, period.to)), inComparedDays(keywordDay.day, compared))))
      .groupBy(keyword.id, keyword.text, site.id, site.name);
  });
  return rows
    .flatMap((row) => {
      const move = moveOf(row.clicks, row.clicksBefore);
      return move ? [{ ...row, ...move }] : [];
    })
    .sort((a, b) => Math.abs(b.gained) - Math.abs(a.gained) || a.text.localeCompare(b.text))
    .slice(0, limit);
}
