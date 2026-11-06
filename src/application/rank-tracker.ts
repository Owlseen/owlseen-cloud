import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { Tried } from "@/domain/tried";
import type { Database } from "@/infrastructure/db/client";
import { keyword, keywordDay, site, trackedKeyword } from "@/infrastructure/db/schema/search";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { onSites, type SiteScope } from "./search-columns";
import { isUuid, siteIn } from "./sites";
import { periodBefore, type Period } from "./time-range";

export interface TrackedKeyword {
  id: number;
  text: string;
  siteId: string;
  siteName: string;
  clicks: number;
  impressions: number;
  position: number | null;
  positionBefore: number | null;
  /** Its position on each day of the period, oldest first: null on a day it wasn't shown. */
  history: (number | null)[];
}

const LONGEST_KEYWORD = 300;
const NOT_FOLLOWED = "That keyword isn’t followed here.";

function tracked(tx: Database, sites: SiteScope) {
  return tx
    .select({ id: keyword.id, text: keyword.text, siteId: site.id, siteName: site.name })
    .from(trackedKeyword)
    .innerJoin(keyword, eq(keyword.id, trackedKeyword.keywordId))
    .innerJoin(site, eq(site.id, trackedKeyword.siteId))
    .where(onSites(trackedKeyword.siteId, sites))
    .orderBy(site.name, keyword.text);
}

const daysOfKeywords = (tx: Database, ids: number[], { from, to }: Pick<Period, "from" | "to">) =>
  tx
    .select({ id: keywordDay.keywordId, day: keywordDay.day, clicks: keywordDay.clicks, impressions: keywordDay.impressions, position: keywordDay.position })
    .from(keywordDay)
    .where(and(sql`${keywordDay.keywordId} in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`, gte(keywordDay.day, from), lte(keywordDay.day, to)));

type KeywordDayRow = Awaited<ReturnType<typeof daysOfKeywords>>[number];

function weightedPosition(rows: readonly KeywordDayRow[]): number | null {
  const shown = rows.reduce((total, { impressions }) => total + impressions, 0);
  return shown > 0 ? rows.reduce((total, { position, impressions }) => total + position * impressions, 0) / shown : null;
}

const onKeyword = (rows: readonly KeywordDayRow[], id: number) => rows.filter((row) => row.id === id);

/** The keywords a workspace follows, where they stand and how they moved. */
export async function trackedKeywordsOf(db: Database, workspaceId: string, sites: SiteScope, period: Period): Promise<TrackedKeyword[]> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const keywords = await tracked(tx, sites);
    if (keywords.length === 0) return [];
    const ids = keywords.map(({ id }) => id);
    const [now, before] = [await daysOfKeywords(tx, ids, period), await daysOfKeywords(tx, ids, periodBefore(period))];
    return keywords.map((one) => {
      const mine = onKeyword(now, one.id);
      const byDay = new Map(mine.map(({ day, position }) => [day, position]));
      return {
        ...one,
        clicks: mine.reduce((total, { clicks }) => total + clicks, 0),
        impressions: mine.reduce((total, { impressions }) => total + impressions, 0),
        position: weightedPosition(mine),
        positionBefore: weightedPosition(onKeyword(before, one.id)),
        history: period.days.map((day) => byDay.get(day) ?? null),
      };
    });
  });
}

/** The most clicked of them, then by name: a workspace can follow hundreds, each with a position per day. */
export const mostClicked = (keywords: readonly TrackedKeyword[], limit: number): TrackedKeyword[] => [...keywords].sort((a, b) => b.clicks - a.clicks || a.text.localeCompare(b.text)).slice(0, limit);

/** Follows a keyword on a site, seen in search yet or not. Any member may: it changes what they see, and writes to no engine. */
export async function trackKeyword(db: Database, workspaceId: string, siteId: string, text: string): Promise<Tried> {
  const words = text.trim().toLowerCase().slice(0, LONGEST_KEYWORD);
  if (!words) return { ok: false, error: "Say which keyword." };
  if (!(await siteIn(db, workspaceId, siteId))) return { ok: false, error: "There’s no such site here." };
  await withWorkspace(db, workspaceId, async (tx) => {
    const [row] = await tx.insert(keyword).values({ siteId, text: words }).onConflictDoUpdate({ target: [keyword.siteId, keyword.text], set: { text: sql`excluded.text` } }).returning({ id: keyword.id });
    await tx.insert(trackedKeyword).values({ siteId, keywordId: row.id }).onConflictDoNothing();
  });
  return { ok: true, said: `Following “${words}”.` };
}

export async function untrackKeyword(db: Database, workspaceId: string, siteId: string, keywordId: number): Promise<Tried> {
  if (!isUuid(siteId)) return { ok: false, error: NOT_FOLLOWED };
  const removed = await withWorkspace(db, workspaceId, (tx) => tx.delete(trackedKeyword).where(and(eq(trackedKeyword.siteId, siteId), eq(trackedKeyword.keywordId, keywordId))).returning({ id: trackedKeyword.keywordId }));
  return removed.length > 0 ? { ok: true, said: "No longer following it." } : { ok: false, error: NOT_FOLLOWED };
}
