import { and, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { daysBefore } from "@/domain/days";
import type { Figures, Reported } from "@/domain/search";
import type { Database } from "@/infrastructure/db/client";
import { searchDay, site } from "@/infrastructure/db/schema/search";
import { periodBefore, type Period } from "./time-range";

/** The columns every kind of day shares. */
interface DayColumns {
  clicks: PgColumn;
  impressions: PgColumn;
  position: PgColumn;
}

/** Adds rows up: a position only means something weighted by how often it was shown. A float, as a year of a large workspace's impressions overflows an int. */
export const figuresSql = ({ clicks, impressions, position }: DayColumns): { clicks: SQL<number>; impressions: SQL<number>; position: SQL<number | null> } => ({
  clicks: sql<number>`coalesce(sum(${clicks}), 0)::float8`,
  impressions: sql<number>`coalesce(sum(${impressions}), 0)::float8`,
  position: sql<number | null>`(sum(${position} * ${impressions}) filter (where ${position} is not null) / nullif(sum(${impressions}) filter (where ${position} is not null), 0))::float8`,
});

export const NO_FIGURES: Figures = { clicks: 0, impressions: 0, position: null };

/** What's being read: one site, a group's sites, or everything row-level security leaves. */
export type SiteScope = string | readonly string[] | null;

/** A scope as a condition. An empty group reads nothing, rather than everything. */
export function onSites(column: PgColumn, scope: SiteScope): SQL | undefined {
  if (scope === null) return undefined;
  if (typeof scope === "string") return eq(column, scope);
  return scope.length > 0 ? inArray(column, [...scope]) : sql`false`;
}

/** An engine reports days late, so an empty day this recent says nothing yet. */
const LATE_DAYS = 3;
/** However late an engine is, silence this long means something, even with no other site here to measure it by. */
const LATEST_AN_ENGINE_IS = 6;
/** How long after its last row a site gone quiet is still compared with what it had: past that, it's old news. */
const QUIET_SHOWN_DAYS = 28;

type DaysTable = PgTable & { siteId: PgColumn; day: PgColumn; engine?: PgColumn };

/**
 * What a period is measured against, for each site on each engine. Each day is set against the one a
 * whole period earlier, so weekdays line up, and today is never compared. Beyond that it depends on why
 * rows stop, as an engine lists nothing for a day with no impressions:
 *
 * - Read to the end since yesterday began: an empty day that engine has got past, going by this
 *   workspace's other sites, means nothing happened. A site that has gone quiet since the time before is
 *   measured against the last stretch it had, or losing all its traffic would read as nothing against nothing.
 * - Reads that stopped: nothing is known of those days, so the comparison stops where its rows do, and
 *   with nothing in the period, it counts on neither side. A dead connection says so as a dead connection.
 */
export function comparedDays(tx: Database, table: DaysTable, period: Period) {
  const wholeDay = sql`${period.lastWholeDay}::date`;
  const before = periodBefore(period).from;
  const engineReadAt = table.engine ? sql`case ${table.engine} when 'google' then ${site.googleReadAt} else ${site.bingReadAt} end` : sql`${site.googleReadAt}`;
  const read = tx
    .select({
      siteId: sql<string>`${table.siteId}`.as("read_site"),
      engine: sql<string>`${table.engine ?? sql`'google'`}`.as("read_engine"),
      lastRow: sql<string>`max(${table.day})`.as("last_row"),
      clean: sql<boolean>`coalesce(${engineReadAt} >= ${wholeDay}, false)`.as("read_clean"),
      reach: sql<string>`least(${wholeDay} - ${LATE_DAYS}::int, greatest(max(max(${table.day})) over (partition by ${table.engine ?? sql`'google'`}), ${wholeDay} - ${LATEST_AN_ENGINE_IS}::int))`.as("read_reach"),
    })
    .from(table)
    .innerJoin(site, eq(site.id, table.siteId))
    .where(and(gte(table.day, daysBefore(before, QUIET_SHOWN_DAYS)), lte(table.day, period.to)))
    .groupBy(...[table.siteId, site.id, ...(table.engine ? [table.engine] : [])])
    .as("read");
  const length = period.days.length;
  const quiet = sql`${read.clean} and ${read.lastRow} < ${before}::date`;
  return tx
    .select({
      siteId: read.siteId,
      engine: read.engine,
      lastRow: read.lastRow,
      clean: read.clean,
      reach: read.reach,
      daysFrom: sql<string>`case when ${quiet} then ${read.lastRow} - ${length - 1}::int else ${before}::date end`.as("compared_from"),
      daysTo: sql<string | null>`case when ${quiet} then ${read.lastRow}
        when not ${read.clean} and ${read.lastRow} < ${period.from}::date then null
        else least(case when ${read.clean} then greatest(${read.lastRow}, ${read.reach}) else ${read.lastRow} end, ${wholeDay}) - ${length}::int end`.as("compared_to"),
    })
    .from(read)
    .as("compared");
}

export type ComparedDays = ReturnType<typeof comparedDays>;

/** Joins a table's days to what they're compared on. Inner: a site with nothing in reach counts on neither side. */
export const onCompared = (table: DaysTable, compared: ComparedDays) => and(eq(table.siteId, compared.siteId), table.engine ? eq(table.engine, compared.engine) : undefined);

/** The days to measure against. */
export const inComparedDays = (day: PgColumn, compared: ComparedDays) => and(sql`${day} >= ${compared.daysFrom}`, sql`${day} <= ${compared.daysTo}`);

/** The last day each engine has reported here, whichever site: what a screen says figures go up to. A site with nothing that far has had nothing. */
export async function reportedUpTo(tx: Database): Promise<Reported> {
  const rows = await tx.select({ engine: searchDay.engine, last: sql<string>`max(${searchDay.day})` }).from(searchDay).groupBy(searchDay.engine);
  return Object.fromEntries(rows.map(({ engine, last }) => [engine, last]));
}
