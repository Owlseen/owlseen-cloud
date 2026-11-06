import { and, desc, eq, gt, gte, lt, lte, ne, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { alertOf, INDEXED_VERDICT, type Alert } from "@/domain/search";
import { dayOf, daysBefore } from "@/domain/days";
import type { Database } from "@/infrastructure/db/client";
import { indexCheck, searchDay, site } from "@/infrastructure/db/schema/search";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { comparedDays, inComparedDays, onCompared, onSites, type SiteScope } from "./search-columns";
import { wholeDaysUpTo } from "./time-range";

export interface SiteAlert extends Alert {
  siteId: string;
  siteName: string;
}

const WEEK_DAYS = 7;
const SEVERITY_ORDER = { high: 0, medium: 1, info: 2 } as const;

/** Sites whose clicks moved a lot, the last seven days against the seven before, what's falling hardest first. Today is left out, and the week before stops where each site and engine has reported up to: they report late. */
export async function alertsOf(db: Database, workspaceId: string, sites: SiteScope, now: Date): Promise<SiteAlert[]> {
  const week = wholeDaysUpTo(now, WEEK_DAYS);
  const rows = await withWorkspace(db, workspaceId, (tx) => {
    const compared = comparedDays(tx, searchDay, week);
    return tx
      .select({
        siteId: site.id,
        siteName: site.name,
        clicks: sql<number>`coalesce(sum(${searchDay.clicks}) filter (where ${searchDay.day} >= ${week.from}), 0)::float8`,
        clicksBefore: sql<number>`coalesce(sum(${searchDay.clicks}) filter (where ${searchDay.day} < ${week.from}), 0)::float8`,
        lastRow: sql<string>`max(${compared.lastRow})::text`,
        clean: sql<boolean>`bool_or(${compared.clean})`,
        reach: sql<string>`max(${compared.reach})::text`,
      })
      .from(searchDay)
      .innerJoin(site, eq(site.id, searchDay.siteId))
      .innerJoin(compared, onCompared(searchDay, compared))
      .where(and(onSites(searchDay.siteId, sites), or(and(gte(searchDay.day, week.from), lte(searchDay.day, week.to)), inComparedDays(searchDay.day, compared))))
      .groupBy(site.id, site.name);
  });
  return rows
    .flatMap(({ siteId: id, siteName, clicks, clicksBefore, lastRow, clean, reach }) => {
      // Read to the end, and nothing listed on days the engine has got past: all its traffic has gone.
      const alert = alertOf(clicks, clicksBefore, clean && lastRow < reach ? lastRow : undefined);
      return alert ? [{ siteId: id, siteName, ...alert }] : [];
    })
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.change - b.change);
}

export interface SiteDrop {
  siteId: string;
  siteName: string;
  pages: number;
}

const DROPS_SHOWN_DAYS = 7;

/**
 * Sites with pages found out of the index this week that were in it at the check before: it's said
 * once, when it happens, and not again each time a page long gone is asked about. A page back in isn't said.
 */
export async function pagesDroppedOf(db: Database, workspaceId: string, sites: SiteScope, now: Date): Promise<SiteDrop[]> {
  const since = daysBefore(dayOf(now), DROPS_SHOWN_DAYS);
  const later = alias(indexCheck, "later");
  const earlier = alias(indexCheck, "earlier");
  return withWorkspace(db, workspaceId, (tx) =>
    tx
      .select({ siteId: site.id, siteName: site.name, pages: sql<number>`count(*)::int` })
      .from(indexCheck)
      .innerJoin(site, eq(site.id, indexCheck.siteId))
      .where(
        and(
          onSites(indexCheck.siteId, sites),
          gte(indexCheck.day, since),
          ne(indexCheck.verdict, INDEXED_VERDICT),
          eq(tx.select({ verdict: earlier.verdict }).from(earlier).where(and(eq(earlier.pageId, indexCheck.pageId), lt(earlier.day, indexCheck.day))).orderBy(desc(earlier.day)).limit(1), INDEXED_VERDICT),
          notExists(tx.select({ one: sql`1` }).from(later).where(and(eq(later.pageId, indexCheck.pageId), gt(later.day, indexCheck.day)))),
        ),
      )
      .groupBy(site.id, site.name)
      .orderBy(desc(sql`count(*)`), site.name),
  );
}
