import { eq, isNull, lt, or, sql } from "drizzle-orm";
import { BRAND } from "@/domain/brand";
import { dayAfter, dayOf, daysBefore } from "@/domain/days";
import { ENGINE_NAMES, ENGINES, type Engine } from "@/domain/search";
import { isRefusal, ProviderError } from "@/infrastructure/connectors/http";
import type { Database } from "@/infrastructure/db/client";
import { site } from "@/infrastructure/db/schema/search";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { logFailure } from "@/infrastructure/logging/failures";
import { accountsOnce, askInTurn } from "./accounts";
import type { OpenedConnection } from "./connections";
import type { KeywordsAndPages, NamedSlice, SearchFigures, Sitemaps } from "./ports";
import { atOnce, OutOfTime, withinBudget } from "./run-budget";
import type { Services } from "./services";
import { saveEngineDays, saveKeywordDays, savePageDays, replaceSitemaps } from "./site-days";
import { propertyFor, type SiteRow } from "./sites";

/** A recent day keeps changing for a while: engines report late. */
const RECENT_DAYS = 10;
/** The first time, as far back as Search Console goes: its history is worth having and costs one call a site. */
const FIRST_TOTALS_DAYS = 480;
/** Keywords and pages cost many more rows: enough to compare two periods and see what's moving. */
const FIRST_DETAIL_DAYS = 90;
/** A few at once, well under what Google allows: one at a time, a run only gets through a few dozen sites. See docs/01-daily-read.md. */
const SITES_AT_ONCE = 4;
/** How long a read under way may run past the deadline before it stops where it's got to: nearly all finish, and a large one carries on next run. */
const FINISHING_MS = 30_000;
/** What's kept of a run for sites that have been failing, however many others are waiting: they may have come back. */
const SHARE_FOR_FAILING = 0.2;
const NOBODY_TO_ASK = "No connected account can read this site.";
const OUR_SIDE = `${BRAND} couldn’t finish this read, on its own side. It will try again.`;
/** Said before a read starts, so a read the platform stops leaves this behind, and its site waits behind the others. */
const DIDNT_FINISH = "This read didn’t finish. It carries on at the next run.";

export interface SyncReport {
  synced: number;
  failed: number;
  /** Left for the next run: the time ran out. */
  left: number;
}

type Outcome = "synced" | "failed" | "left";

const READ_AT = { google: "googleReadAt", bing: "bingReadAt" } as const satisfies Record<Engine, keyof SiteRow>;

const earlierOf = (a: string, b: string) => (a < b ? a : b);
const laterOf = (a: string, b: string) => (a > b ? a : b);

/**
 * Where an engine's read starts. The first goes as far back as is worth having. Later ones ask the
 * recent days, and back past the last time this engine was read to the end: whatever a run of failures
 * missed, nothing else would fill. It's the engine's own: another one's trouble widens nothing.
 */
function readFrom(readAt: Date | null, today: string, furthestBack: number): string {
  const furthest = daysBefore(today, furthestBack);
  if (readAt === null) return furthest;
  return laterOf(furthest, earlierOf(daysBefore(today, RECENT_DAYS), daysBefore(dayOf(readAt), RECENT_DAYS)));
}

/**
 * What to remember of how far a slice got. Only what's older than the days every read asks again: past
 * that, a read that then fails on something else would carry on after days it hasn't finished with.
 */
const stoppedAt = (through: string, today: string) => (through < daysBefore(today, RECENT_DAYS) ? through : null);

interface SyncRun {
  services: Services;
  deadline: number;
  today: string;
}

const saying = (services: Services, row: SiteRow, values: Partial<typeof site.$inferInsert>) => withWorkspace(services.db, row.workspaceId, (tx) => tx.update(site).set(values).where(eq(site.id, row.id)));

/** One kind of detail, slice by slice, each saved with how far it got: a large property gets further each run, even if no run sees it through. */
async function readDetail(run: SyncRun, row: SiteRow, slices: (from: string, to: string) => AsyncIterable<NamedSlice>, readThrough: string | null, save: (tx: Database, slice: NamedSlice) => Promise<void>): Promise<void> {
  const { services, today, deadline } = run;
  const from = readThrough ? dayAfter(readThrough) : readFrom(row.googleReadAt, today, FIRST_DETAIL_DAYS);
  if (from > today) return;
  for await (const slice of slices(from, today)) {
    await withWorkspace(services.db, row.workspaceId, (tx) => save(tx, slice));
    if (services.now().getTime() >= deadline + FINISHING_MS) throw new OutOfTime();
  }
}

/** One engine's figures for one site, each kind in its own transactions, so a long keyword read holds nothing open. */
async function readEngine(run: SyncRun, row: SiteRow, { client }: OpenedConnection): Promise<void> {
  const { services, today } = run;
  const source = client as SearchFigures & Partial<KeywordsAndPages & Sitemaps>;
  const { engine } = source;
  const property = propertyFor(row, engine) as string;
  const days = await source.days(property, readFrom(row[READ_AT[engine]], today, FIRST_TOTALS_DAYS), today);
  await withWorkspace(services.db, row.workspaceId, (tx) => saveEngineDays(tx, row.id, engine, days));
  if (source.keywordSlices) {
    await readDetail(run, row, (from, to) => (source as KeywordsAndPages).keywordSlices(property, from, to), row.keywordsReadThrough, async (tx, { days: found, through }) => {
      await saveKeywordDays(tx, row.id, found);
      await tx.update(site).set({ keywordsReadThrough: stoppedAt(through, today) }).where(eq(site.id, row.id));
    });
  }
  if (source.pageSlices) {
    await readDetail(run, row, (from, to) => (source as KeywordsAndPages).pageSlices(property, from, to), row.pagesReadThrough, async (tx, { days: found, through }) => {
      await savePageDays(tx, row.id, found);
      await tx.update(site).set({ pagesReadThrough: stoppedAt(through, today) }).where(eq(site.id, row.id));
    });
  }
  if (source.sitemaps) {
    const sitemaps = await source.sitemaps(property);
    await withWorkspace(services.db, row.workspaceId, (tx) => replaceSitemaps(tx, row.id, engine, sitemaps));
  }
  const finished = engine === "google" ? { googleReadAt: services.now(), keywordsReadThrough: null, pagesReadThrough: null } : { bingReadAt: services.now() };
  await saying(services, row, finished);
}

const engineOf = ({ client }: OpenedConnection) => (client as SearchFigures).engine;

const nobodyOn = (engine: Engine) => `No connected ${ENGINE_NAMES[engine]} account can read this site.`;

const readToday = (row: SiteRow, engine: Engine, today: string) => {
  const readAt = row[READ_AT[engine]];
  return readAt !== null && dayOf(readAt) === today;
};

/** What became of a site's engines: read, or why not. */
interface EnginesRead {
  read: number;
  /** Engines that won't be read until someone acts: a note, and no reason to ask again before tomorrow. */
  nobodyOn: Engine[];
  refusals: string[];
  /** A failure that may pass: the site stays due. */
  failure?: string;
}

/** Each engine a site is on, one's trouble staying its own. One read earlier today isn't asked twice. */
async function readEngines(run: SyncRun, row: SiteRow, connections: readonly OpenedConnection[], engines: readonly Engine[]): Promise<EnginesRead> {
  const outcome: EnginesRead = { read: 0, nobodyOn: [], refusals: [] };
  for (const engine of engines) {
    const accounts = connections.filter((connection) => engineOf(connection) === engine);
    if (readToday(row, engine, run.today)) outcome.read += 1;
    else if (accounts.length === 0) outcome.nobodyOn.push(engine);
    else {
      try {
        await askInTurn(run.services, row.workspaceId, accounts, (account) => readEngine(run, row, account));
        outcome.read += 1;
      } catch (error) {
        if (isRefusal(error)) outcome.refusals.push(error.message);
        else if (error instanceof ProviderError) outcome.failure = error.message;
        else throw error;
      }
    }
  }
  return outcome;
}

/**
 * One site, every engine it's on. Once the engines that can be read were, it's done for the day, saying
 * what it couldn't read: an engine with no account or a dead key mustn't have the others read again on every run.
 */
async function syncSite(run: SyncRun, row: SiteRow, connections: readonly OpenedConnection[]): Promise<Outcome> {
  const { services } = run;
  const engines = ENGINES.filter((engine) => propertyFor(row, engine));
  await saying(services, row, { lastSyncError: DIDNT_FINISH, lastReadFailed: true });
  const { read, nobodyOn: unread, refusals, failure } = await readEngines(run, row, connections, engines);
  if (failure) {
    await saying(services, row, { lastSyncError: failure, lastReadFailed: true });
    return "failed";
  }
  if (read === 0) {
    await saying(services, row, { lastSyncError: refusals.join(" ") || NOBODY_TO_ASK, lastReadFailed: true });
    return "failed";
  }
  const notes = [...refusals, ...unread.map(nobodyOn)];
  await saying(services, row, { lastSyncedAt: services.now(), lastSyncError: notes.join(" ") || null, lastReadFailed: false });
  return "synced";
}

/** What's said on a site's row: a service's own words, or that it was on our side, which the logs then hold. */
function whyNot(row: SiteRow, error: unknown): string {
  if (error instanceof ProviderError) return error.message;
  logFailure(`Reading site ${row.id}`, error);
  return OUR_SIDE;
}

/** One site's read, whatever goes wrong: nothing about one site or one workspace may stop the job for the others. */
async function readSite(run: SyncRun, row: SiteRow, accounts: (workspaceId: string) => Promise<OpenedConnection[]>): Promise<Outcome> {
  try {
    return await syncSite(run, row, await accounts(row.workspaceId));
  } catch (error) {
    // What was saved stays saved, and the row already says the read didn't finish.
    if (error instanceof OutOfTime) return "left";
    await saying(run.services, row, { lastSyncError: whyNot(row, error), lastReadFailed: true }).catch((failure) => logFailure(`Saying why site ${row.id} went unread`, failure));
    return "failed";
  }
}

/** Sites not read yet today, those read longest ago first. Trusted path: the job works across every workspace. */
function sitesDue(db: Database, today: string): Promise<SiteRow[]> {
  return db
    .select()
    .from(site)
    .where(or(isNull(site.lastSyncedAt), lt(site.lastSyncedAt, new Date(`${today}T00:00:00.000Z`))))
    // Postgres puts nulls last unless told otherwise, and a site never read has waited longest.
    .orderBy(sql`${site.lastSyncedAt} asc nulls first`);
}

/**
 * Which site next: those that were fine first, so a site that keeps failing can't use up every run, and
 * those failing once a share of the time is left, so that they still get asked on a run too short for all.
 */
function turns(due: readonly SiteRow[], services: Services, deadline: number) {
  const fine = due.filter(({ lastReadFailed }) => !lastReadFailed);
  const failing = due.filter(({ lastReadFailed }) => lastReadFailed);
  const failingTurn = deadline - (deadline - services.now().getTime()) * SHARE_FOR_FAILING;
  return {
    next: (): SiteRow | undefined => {
      const now = services.now().getTime();
      if (now >= deadline) return undefined;
      return now >= failingTurn ? (failing.shift() ?? fine.shift()) : (fine.shift() ?? failing.shift());
    },
    left: () => fine.length + failing.length,
  };
}

/** Reads every site due until the time runs out; the next run carries on where this one stopped. */
export async function syncDueSites(given: Services, deadline: number): Promise<SyncReport> {
  const services = withinBudget(given, deadline);
  const run: SyncRun = { services, deadline, today: dayOf(services.now()) };
  const queue = turns(await sitesDue(services.db, run.today), services, deadline);
  const accounts = accountsOnce(services, "search_figures");
  const report: SyncReport = { synced: 0, failed: 0, left: 0 };
  await atOnce(SITES_AT_ONCE, queue.next, async (row) => {
    report[await readSite(run, row, accounts)] += 1;
  });
  report.left += queue.left();
  return report;
}
