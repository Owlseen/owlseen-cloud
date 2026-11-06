import { and, eq, gte, lte, max, type SQL } from "drizzle-orm";
import type { Engine, Figures, Reported } from "@/domain/search";
import type { Database } from "@/infrastructure/db/client";
import { searchDay, site } from "@/infrastructure/db/schema/search";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { comparedDays, figuresSql, inComparedDays, NO_FIGURES, onCompared, onSites, reportedUpTo, type SiteScope } from "./search-columns";
import type { Period } from "./time-range";

/** Whose day a date is: the engines', not ours, and Google's runs on Pacific time. */
export const DAY_NOTE = "Days are as each engine reports them: Google’s run on Pacific time.";

export interface DayFigures extends Figures {
  date: string;
}

export interface EngineFigures extends Figures {
  engine: Engine;
}

export interface Overview {
  from: string;
  to: string;
  dayNote: typeof DAY_NOTE;
  /** When a site here was last read from its engines. */
  lastSyncedAt: Date | null;
  totals: Figures;
  /** The last day each engine has reported: the days after it aren't zeros, they aren't known yet. */
  reportedUpTo: Reported;
  /** The time just before, as far as the engines have reported this period. */
  totalsBefore: Figures;
  days: DayFigures[];
  engines: EngineFigures[];
}

export interface OverviewQuery {
  sites: SiteScope;
  period: Period;
  engine?: Engine;
}

const scope = ({ sites, engine }: Pick<OverviewQuery, "sites" | "engine">, { from, to }: Pick<Period, "from" | "to">): SQL | undefined =>
  and(onSites(searchDay.siteId, sites), engine ? eq(searchDay.engine, engine) : undefined, gte(searchDay.day, from), lte(searchDay.day, to));

async function totalsOver(tx: Database, query: OverviewQuery, range: Pick<Period, "from" | "to">): Promise<Figures> {
  const [row] = await tx.select(figuresSql(searchDay)).from(searchDay).where(scope(query, range));
  return row ?? NO_FIGURES;
}

async function totalsBeforeOf(tx: Database, { sites, engine, period }: OverviewQuery): Promise<Figures> {
  const compared = comparedDays(tx, searchDay, period);
  const [row] = await tx
    .select(figuresSql(searchDay))
    .from(searchDay)
    .innerJoin(compared, onCompared(searchDay, compared))
    .where(and(onSites(searchDay.siteId, sites), engine ? eq(searchDay.engine, engine) : undefined, inComparedDays(searchDay.day, compared)));
  return row ?? NO_FIGURES;
}

/** Each day of the period, a quiet one as zeros rather than as nothing. */
async function dayFigures(tx: Database, query: OverviewQuery): Promise<DayFigures[]> {
  const rows = await tx.select({ date: searchDay.day, ...figuresSql(searchDay) }).from(searchDay).where(scope(query, query.period)).groupBy(searchDay.day);
  const known = new Map(rows.map((row) => [row.date, row]));
  return query.period.days.map((date) => known.get(date) ?? { date, ...NO_FIGURES });
}

const engineFigures = (tx: Database, query: OverviewQuery): Promise<EngineFigures[]> =>
  tx.select({ engine: searchDay.engine, ...figuresSql(searchDay) }).from(searchDay).where(scope({ sites: query.sites }, query.period)).groupBy(searchDay.engine).orderBy(searchDay.engine);

async function lastSynced(tx: Database, sites: SiteScope): Promise<Date | null> {
  const [row] = await tx.select({ at: max(site.lastSyncedAt) }).from(site).where(onSites(site.id, sites));
  return row?.at ?? null;
}

/** One site's search over a period, or a whole workspace's: stored figures, so it costs no quota. */
export function overviewOf(db: Database, workspaceId: string, query: OverviewQuery): Promise<Overview> {
  const { period } = query;
  return withWorkspace(db, workspaceId, async (tx) => ({
    from: period.from,
    to: period.to,
    dayNote: DAY_NOTE,
    lastSyncedAt: await lastSynced(tx, query.sites),
    reportedUpTo: await reportedUpTo(tx),
    totals: await totalsOver(tx, query, period),
    totalsBefore: await totalsBeforeOf(tx, query),
    days: await dayFigures(tx, query),
    engines: await engineFigures(tx, query),
  }));
}
