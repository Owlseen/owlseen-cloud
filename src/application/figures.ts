import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { ctrOf, type Figures, type Reported } from "@/domain/search";
import type { Database } from "@/infrastructure/db/client";
import { keyword, keywordDay, page, pageDay, searchDay, site } from "@/infrastructure/db/schema/search";
import { workspace } from "@/infrastructure/db/schema/tenancy";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { DAY_NOTE } from "./overview";
import { figuresSql, NO_FIGURES, reportedUpTo } from "./search-columns";
import type { Period } from "./time-range";

export interface DayOfFigures extends Figures {
  date: string;
  ctr: number;
}

export interface SiteFigures {
  id: string;
  name: string;
  lastSyncedAt: Date | null;
  days: DayOfFigures[];
}

export interface WorkspaceFigures {
  /** Whose figures these are: what an app holding a key can name them by. */
  workspace: { id: string; name: string };
  from: string;
  to: string;
  dayNote: typeof DAY_NOTE;
  /** The last day each engine has reported: a zero after it isn't a quiet day, it isn't known yet. */
  reportedUpTo: Reported;
  sites: SiteFigures[];
  /** The next page of sites, when there are more. */
  nextPage: number | null;
}

const withCtr = <T extends Figures>(row: T) => ({ ...row, ctr: ctrOf(row) });

/** 50 sites at a time: a year of a few hundred sites would otherwise be many megabytes in one answer. */
const SITES_A_PAGE = 50;

/** Per site and per day, for an app holding a key: both engines together, a page of sites at a time. Counts only: which keywords and pages, it has to ask for by name. */
export async function figuresOf(db: Database, workspaceId: string, period: Period, siteId?: string, page = 1): Promise<WorkspaceFigures> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [named] = await tx.select({ id: workspace.id, name: workspace.name }).from(workspace).where(eq(workspace.id, workspaceId));
    const offset = (page - 1) * SITES_A_PAGE;
    // A page so far along that it can't even be counted to has no sites on it.
    const found = Number.isSafeInteger(offset) ? await tx.select({ id: site.id, name: site.name, lastSyncedAt: site.lastSyncedAt }).from(site).where(siteId ? eq(site.id, siteId) : undefined).orderBy(asc(site.name)).limit(SITES_A_PAGE + 1).offset(offset) : [];
    const sites = found.slice(0, SITES_A_PAGE);
    const ids = sites.map(({ id }) => id);
    const rows = ids.length === 0 ? [] : await tx.select({ siteId: searchDay.siteId, date: searchDay.day, ...figuresSql(searchDay) }).from(searchDay).where(and(inArray(searchDay.siteId, ids), gte(searchDay.day, period.from), lte(searchDay.day, period.to))).groupBy(searchDay.siteId, searchDay.day);
    const known = new Map(rows.map(({ siteId: rowSite, ...row }) => [`${rowSite}\n${row.date}`, row]));
    const dayOn = (id: string, date: string) => withCtr({ date, ...NO_FIGURES, ...known.get(`${id}\n${date}`) });
    return { workspace: named, from: period.from, to: period.to, dayNote: DAY_NOTE, reportedUpTo: await reportedUpTo(tx), sites: sites.map((one) => ({ ...one, days: period.days.map((date) => dayOn(one.id, date)) })), nextPage: found.length > SITES_A_PAGE ? page + 1 : null };
  });
}

/** What a day's figure can be asked of, by name. */
export const BREAKDOWNS = ["keyword", "page"] as const;
export type Breakdown = (typeof BREAKDOWNS)[number];

export interface BreakdownFigures {
  site: { id: string; name: string };
  dimension: Breakdown;
  value: string;
  from: string;
  to: string;
  dayNote: typeof DAY_NOTE;
  days: DayOfFigures[];
}

export interface BreakdownQuery {
  siteId: string;
  dimension: Breakdown;
  value: string;
  period: Period;
}

const keywordDaysNamed = (tx: Database, { siteId, value, period }: BreakdownQuery) =>
  tx
    .select({ date: keywordDay.day, clicks: keywordDay.clicks, impressions: keywordDay.impressions, position: keywordDay.position })
    .from(keywordDay)
    .innerJoin(keyword, eq(keyword.id, keywordDay.keywordId))
    .where(and(eq(keywordDay.siteId, siteId), eq(keyword.text, value), gte(keywordDay.day, period.from), lte(keywordDay.day, period.to)));

const pageDaysNamed = (tx: Database, { siteId, value, period }: BreakdownQuery) =>
  tx
    .select({ date: pageDay.day, clicks: pageDay.clicks, impressions: pageDay.impressions, position: pageDay.position })
    .from(pageDay)
    .innerJoin(page, eq(page.id, pageDay.pageId))
    .where(and(eq(pageDay.siteId, siteId), eq(page.url, value), gte(pageDay.day, period.from), lte(pageDay.day, period.to)));

/** One keyword's or one page's days: the caller names it, so this lists nothing a key didn't already know. Undefined for a site that isn't this workspace's. */
export async function breakdownOf(db: Database, workspaceId: string, query: BreakdownQuery): Promise<BreakdownFigures | undefined> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [found] = await tx.select({ id: site.id, name: site.name }).from(site).where(eq(site.id, query.siteId));
    if (!found) return undefined;
    const rows = await (query.dimension === "keyword" ? keywordDaysNamed(tx, query) : pageDaysNamed(tx, query));
    const known = new Map(rows.map((row) => [row.date, row]));
    return { site: found, dimension: query.dimension, value: query.value, from: query.period.from, to: query.period.to, dayNote: DAY_NOTE, days: query.period.days.map((date) => withCtr({ ...NO_FIGURES, ...known.get(date), date })) };
  });
}
