import { and, eq, inArray, sql } from "drizzle-orm";
import type { Engine } from "@/domain/search";
import type { Database } from "@/infrastructure/db/client";
import { keyword, keywordDay, page, pageDay, searchDay, sitemap } from "@/infrastructure/db/schema/search";
import type { EngineDay, EngineSitemap, NamedDay } from "./ports";

const ROWS_AT_ONCE = 500;
/**
 * Longer than an index can hold, and no use to anyone: an address with a whole query in it, say.
 * One such row would otherwise fail the whole read of its site, every day.
 */
const LONGEST_NAME_BYTES = 2_000;

const REPLACED = { clicks: sql`excluded.clicks`, impressions: sql`excluded.impressions`, position: sql`excluded.position` };

function inChunks<T>(items: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += ROWS_AT_ONCE) chunks.push(items.slice(start, start + ROWS_AT_ONCE));
  return chunks;
}

/** A site's totals per day, replacing what an engine said earlier: a recent day keeps changing until it settles. All in the caller's transaction and workspace. */
export async function saveEngineDays(tx: Database, siteId: string, engine: Engine, days: readonly EngineDay[]): Promise<void> {
  for (const chunk of inChunks(days)) {
    await tx
      .insert(searchDay)
      .values(chunk.map((day) => ({ siteId, engine, ...day })))
      .onConflictDoUpdate({ target: [searchDay.siteId, searchDay.day, searchDay.engine], set: REPLACED });
  }
}

type Named = { id: number; name: string };

/**
 * Each name's id. Those known are looked up rather than upserted: an upsert takes a new number from
 * the sequence for every row it tries, known or not, and a read runs over the same names every day.
 */
async function idsOfNames(names: readonly string[], known: (chunk: string[]) => Promise<Named[]>, add: (chunk: string[]) => Promise<Named[]>): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (const chunk of inChunks(names)) for (const { id, name } of await known(chunk)) ids.set(name, id);
  for (const chunk of inChunks(names.filter((name) => !ids.has(name)))) for (const { id, name } of await add(chunk)) ids.set(name, id);
  return ids;
}

/** One row a key a day: an engine repeating itself in one answer would make a single insert touch a row twice. */
function keptDays(days: readonly NamedDay[]): NamedDay[] {
  const fitting = days.filter(({ name }) => Buffer.byteLength(name) <= LONGEST_NAME_BYTES);
  return [...new Map(fitting.map((day) => [`${day.name}\n${day.day}`, day])).values()];
}

const figuresOf = ({ day, clicks, impressions, position }: NamedDay) => ({ day, clicks, impressions, position });

export async function saveKeywordDays(tx: Database, siteId: string, days: readonly NamedDay[]): Promise<void> {
  const kept = keptDays(days);
  const named = { id: keyword.id, name: keyword.text };
  const ids = await idsOfNames(
    [...new Set(kept.map(({ name }) => name))],
    (chunk) => tx.select(named).from(keyword).where(and(eq(keyword.siteId, siteId), inArray(keyword.text, chunk))),
    (chunk) => tx.insert(keyword).values(chunk.map((text) => ({ siteId, text }))).onConflictDoUpdate({ target: [keyword.siteId, keyword.text], set: { text: sql`excluded.text` } }).returning(named),
  );
  for (const chunk of inChunks(kept)) {
    await tx
      .insert(keywordDay)
      .values(chunk.map((day) => ({ siteId, keywordId: ids.get(day.name) as number, ...figuresOf(day) })))
      .onConflictDoUpdate({ target: [keywordDay.siteId, keywordDay.day, keywordDay.keywordId], set: REPLACED });
  }
}

export async function savePageDays(tx: Database, siteId: string, days: readonly NamedDay[]): Promise<void> {
  const kept = keptDays(days);
  const named = { id: page.id, name: page.url };
  const ids = await idsOfNames(
    [...new Set(kept.map(({ name }) => name))],
    (chunk) => tx.select(named).from(page).where(and(eq(page.siteId, siteId), inArray(page.url, chunk))),
    (chunk) => tx.insert(page).values(chunk.map((url) => ({ siteId, url }))).onConflictDoUpdate({ target: [page.siteId, page.url], set: { url: sql`excluded.url` } }).returning(named),
  );
  for (const chunk of inChunks(kept)) {
    await tx
      .insert(pageDay)
      .values(chunk.map((day) => ({ siteId, pageId: ids.get(day.name) as number, ...figuresOf(day) })))
      .onConflictDoUpdate({ target: [pageDay.siteId, pageDay.day, pageDay.pageId], set: REPLACED });
  }
}

/** What an engine says of a site's sitemaps now: one it no longer lists is gone. */
export async function replaceSitemaps(tx: Database, siteId: string, engine: Engine, sitemaps: readonly EngineSitemap[]): Promise<void> {
  await tx.delete(sitemap).where(and(eq(sitemap.siteId, siteId), eq(sitemap.engine, engine)));
  if (sitemaps.length > 0) await tx.insert(sitemap).values(sitemaps.map((one) => ({ siteId, engine, ...one })));
}
