import { and, asc, eq, gte, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { dayOf, daysBefore } from "@/domain/days";
import { indexStandingOf, type Engine } from "@/domain/search";
import { managesSettings, NOT_A_MANAGER_OF_SETTINGS } from "@/domain/team";
import type { Tried } from "@/domain/tried";
import { isQuota, isRefusal, ProviderError } from "@/infrastructure/connectors/http";
import type { Database } from "@/infrastructure/db/client";
import { indexCheck, page, site, sitemap } from "@/infrastructure/db/schema/search";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { logFailure } from "@/infrastructure/logging/failures";
import { accountsOnce, askInTurn } from "./accounts";
import { connectionsWith, type OpenedConnection } from "./connections";
import type { EngineSitemap, IndexStatus, Inspection, Sitemaps } from "./ports";
import { atOnce, OutOfTime, withinBudget } from "./run-budget";
import type { Services } from "./services";
import { replaceSitemaps } from "./site-days";
import { onSites, type SiteScope } from "./search-columns";
import { propertyFor, siteIn } from "./sites";
import { roleIn } from "./team";

/** Google allows 2,000 inspections a site a day, and a member may want some of them. */
const MOST_PER_SITE_A_RUN = 100;
/** A page's status rarely changes faster, and there are many pages to go round: the soonest it's asked again. */
const CHECK_AGAIN_AFTER_DAYS = 7;
/** A few at once, well under Google's 600 a minute per site: one at a time, a run only gets through a few hundred pages. */
const AT_ONCE = 4;
const CHECKS_KEPT_IN_VIEW_DAYS = 180;
const MOST_DROPPED_SHOWN = 50;

export interface DroppedPage {
  url: string;
  since: string;
  coverage: string | null;
}

export interface SiteIndexing {
  siteId: string;
  siteName: string;
  checked: number;
  indexed: number;
  notIndexed: number;
  dropped: DroppedPage[];
  sitemaps: (Omit<typeof sitemap.$inferSelect, "workspaceId" | "siteId">)[];
}

function siteIndexingOf(one: { id: string; name: string }, checks: { pageId: number; url: string; day: string; verdict: string; coverage: string | null }[], sitemaps: (typeof sitemap.$inferSelect)[]): SiteIndexing {
  const byPage = new Map<number, typeof checks>();
  for (const check of checks) byPage.set(check.pageId, [...(byPage.get(check.pageId) ?? []), check]);
  const result: SiteIndexing = { siteId: one.id, siteName: one.name, checked: byPage.size, indexed: 0, notIndexed: 0, dropped: [], sitemaps };
  for (const pageChecks of byPage.values()) {
    const standing = indexStandingOf(pageChecks);
    if (standing.state === "indexed") result.indexed += 1;
    else result.notIndexed += 1;
    if (standing.state === "dropped") result.dropped.push({ url: pageChecks[0].url, since: standing.since, coverage: standing.coverage });
  }
  result.dropped = result.dropped.sort((a, b) => b.since.localeCompare(a.since)).slice(0, MOST_DROPPED_SHOWN);
  return result;
}

/** Which pages each site has indexed, from the checks so far, which dropped out, and its sitemaps as the engines last said: the sites with pages dropping first. */
export async function indexingOf(db: Database, workspaceId: string, scope: SiteScope, now: Date): Promise<SiteIndexing[]> {
  const since = daysBefore(dayOf(now), CHECKS_KEPT_IN_VIEW_DAYS);
  return withWorkspace(db, workspaceId, async (tx) => {
    const sites = await tx.select({ id: site.id, name: site.name }).from(site).where(onSites(site.id, scope)).orderBy(asc(site.name));
    const checks = await tx.select({ siteId: indexCheck.siteId, pageId: indexCheck.pageId, url: page.url, day: indexCheck.day, verdict: indexCheck.verdict, coverage: indexCheck.coverage }).from(indexCheck).innerJoin(page, eq(page.id, indexCheck.pageId)).where(and(onSites(indexCheck.siteId, scope), gte(indexCheck.day, since)));
    const sitemaps = await tx.select().from(sitemap).where(onSites(sitemap.siteId, scope)).orderBy(sitemap.engine, sitemap.url);
    return sites.map((one) => siteIndexingOf(one, checks.filter((check) => check.siteId === one.id), sitemaps.filter((row) => row.siteId === one.id))).sort((a, b) => b.dropped.length - a.dropped.length || a.siteName.localeCompare(b.siteName));
  });
}

const googleAccounts = (services: Services, workspaceId: string) => connectionsWith(services, workspaceId, "index_status");

const inspectThrough = (property: string, url: string) => ({ client }: OpenedConnection) => (client as unknown as IndexStatus).inspect(property, url);

function recordCheck(tx: Database, row: { siteId: string; pageId: number }, day: string, inspection: Inspection, now: Date) {
  return Promise.all([
    tx.insert(indexCheck).values({ ...row, day, ...inspection }).onConflictDoUpdate({ target: [indexCheck.pageId, indexCheck.day], set: { ...inspection } }),
    tx.update(page).set({ inspectedAt: now }).where(eq(page.id, row.pageId)),
  ]);
}

type DuePage = { id: number; url: string; siteId: string; property: string | null; workspaceId: string };

/**
 * Pages never asked about or asked longest ago, a limited number per site, in turns: each site's first,
 * then each site's second, those of the site asked about longest ago first, so that a short run reaches
 * different sites each time, and each in time every site. Trusted path: the job works across every workspace.
 */
function pagesDue(db: Database, today: string): Promise<DuePage[]> {
  const before = new Date(`${daysBefore(today, CHECK_AGAIN_AFTER_DAYS)}T00:00:00.000Z`);
  const lastAsked = db.select({ siteId: sql<string>`${page.siteId}`.as("asked_site"), at: sql<Date | null>`max(${page.inspectedAt})`.as("asked_at") }).from(page).groupBy(page.siteId).as("asked");
  const ranked = db
    .select({
      id: page.id,
      url: page.url,
      siteId: page.siteId,
      property: sql<string | null>`${site.googleProperty}`.as("property"),
      workspaceId: sql<string>`${site.workspaceId}`.as("site_workspace"),
      siteAskedAt: lastAsked.at,
      // Postgres puts nulls last unless told otherwise, and those never asked come first.
      turn: sql<number>`row_number() over (partition by ${page.siteId} order by ${page.inspectedAt} asc nulls first, ${page.id})`.as("turn"),
    })
    .from(page)
    .innerJoin(site, eq(site.id, page.siteId))
    .innerJoin(lastAsked, eq(page.siteId, lastAsked.siteId))
    .where(and(isNotNull(site.googleProperty), or(isNull(page.inspectedAt), lt(page.inspectedAt, before))))
    .as("ranked");
  return db
    .select({ id: ranked.id, url: ranked.url, siteId: ranked.siteId, property: ranked.property, workspaceId: ranked.workspaceId })
    .from(ranked)
    .where(lte(ranked.turn, MOST_PER_SITE_A_RUN))
    .orderBy(ranked.turn, sql`${ranked.siteAskedAt} asc nulls first`, ranked.siteId);
}

export interface IndexRunReport {
  checked: number;
  failed: number;
  left: number;
}

/** What a run shares between the checks going on at once. */
interface IndexRun {
  services: Services;
  today: string;
  report: IndexRunReport;
  accounts: (workspaceId: string) => Promise<OpenedConnection[]>;
  /** The account that last answered for a site: another would only refuse it, one wasted call a page. */
  answeredFor: Map<string, OpenedConnection>;
  /** Sites out of quota or refused: their other pages wait for the next run, so the others get theirs. */
  stopped: Set<string>;
}

const moveToBack = (services: Services, row: DuePage) => withWorkspace(services.db, row.workspaceId, (tx) => tx.update(page).set({ inspectedAt: services.now() }).where(eq(page.id, row.id)));

async function checkFailed(run: IndexRun, row: DuePage, error: unknown): Promise<void> {
  if (error instanceof OutOfTime) {
    run.report.left += 1;
    return;
  }
  run.report.failed += 1;
  if (isQuota(error) || isRefusal(error)) run.stopped.add(row.siteId);
  // The engine refuses to answer about this one page: it goes to the back, or it would keep its place at the front for good.
  else if (error instanceof ProviderError && error.status >= 400 && error.status < 500) await moveToBack(run.services, row);
  else if (!(error instanceof ProviderError)) logFailure(`Checking a page of site ${row.siteId}`, error);
}

async function checkPage(run: IndexRun, row: DuePage): Promise<void> {
  const { services, today, report, answeredFor } = run;
  try {
    const accounts = await run.accounts(row.workspaceId);
    if (accounts.length === 0) return;
    const known = answeredFor.get(row.siteId);
    const inTurn = known ? [known, ...accounts.filter((account) => account !== known)] : accounts;
    const inspection = await askInTurn(services, row.workspaceId, inTurn, async (account) => {
      const answer = await inspectThrough(row.property as string, row.url)(account);
      answeredFor.set(row.siteId, account);
      return answer;
    });
    await withWorkspace(services.db, row.workspaceId, (tx) => recordCheck(tx, { siteId: row.siteId, pageId: row.id }, today, inspection, services.now()));
    report.checked += 1;
  } catch (error) {
    await checkFailed(run, row, error);
  }
}

/**
 * Asks about as many pages as there's time for, a few at once. One page failing doesn't stop the rest,
 * and a page is asked again no sooner than a week later: with many pages, it can take longer to come round.
 */
export async function runIndexChecks(given: Services, deadline: number): Promise<IndexRunReport> {
  const services = withinBudget(given, deadline);
  const today = dayOf(services.now());
  const due = await pagesDue(services.db, today);
  const run: IndexRun = { services, today, report: { checked: 0, failed: 0, left: 0 }, accounts: accountsOnce(services, "index_status"), answeredFor: new Map(), stopped: new Set() };
  const queue = [...due].reverse();
  await atOnce(
    AT_ONCE,
    () => queue.pop(),
    async (row) => {
      if (services.now().getTime() >= deadline || run.stopped.has(row.siteId)) run.report.left += 1;
      else await checkPage(run, row);
    },
  );
  return run.report;
}

const sameHost = (url: string, name: string) => {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host === name || host.endsWith(`.${name}`);
  } catch {
    return false;
  }
};

/** Asks Google now about one page of this site. An address on another site is refused, not asked about. */
export async function inspectPage(services: Services, workspaceId: string, siteId: string, url: string): Promise<{ ok: true; inspection: Inspection } | { ok: false; error: string }> {
  const one = await siteIn(services.db, workspaceId, siteId);
  if (!one?.googleProperty) return { ok: false, error: "This site isn’t on Google here." };
  if (!sameHost(url, one.name)) return { ok: false, error: `That address isn’t on ${one.name}.` };
  const accounts = await googleAccounts(services, workspaceId);
  if (accounts.length === 0) return { ok: false, error: "Connect Google first." };
  try {
    return { ok: true, inspection: await askInTurn(services, workspaceId, accounts, inspectThrough(one.googleProperty, url)) };
  } catch (error) {
    if (error instanceof ProviderError) return { ok: false, error: error.message };
    throw error;
  }
}

/** The same for someone at a screen or through an assistant: it spends what Google allows the workspace in a day, so it's for those who manage it. */
export async function inspectPageAs(services: Services, workspaceId: string, userId: string, siteId: string, url: string): ReturnType<typeof inspectPage> {
  if (!managesSettings(await roleIn(services.db, workspaceId, userId))) return { ok: false, error: NOT_A_MANAGER_OF_SETTINGS };
  return inspectPage(services, workspaceId, siteId, url);
}

/** Tells an engine about a sitemap, for those who manage the workspace's settings: it changes what the engine reads. */
export async function submitSitemap(services: Services, workspaceId: string, userId: string, siteId: string, engine: Engine, url: string): Promise<Tried> {
  if (!managesSettings(await roleIn(services.db, workspaceId, userId))) return { ok: false, error: NOT_A_MANAGER_OF_SETTINGS };
  const one = await siteIn(services.db, workspaceId, siteId);
  const property = one && propertyFor(one, engine);
  if (!one || !property) return { ok: false, error: "This site isn’t on that engine here." };
  if (!sameHost(url, one.name)) return { ok: false, error: `That address isn’t on ${one.name}.` };
  const accounts = (await connectionsWith(services, workspaceId, "sitemaps")).filter(({ client }) => (client as unknown as Sitemaps).engine === engine);
  if (accounts.length === 0) return { ok: false, error: "That engine isn’t connected." };
  try {
    const sitemaps = await askInTurn(services, workspaceId, accounts, async ({ client }): Promise<EngineSitemap[]> => {
      const source = client as unknown as Sitemaps;
      await source.submitSitemap(property, url);
      return source.sitemaps(property);
    });
    await withWorkspace(services.db, workspaceId, (tx) => replaceSitemaps(tx, siteId, engine, sitemaps));
    return { ok: true, said: "Submitted." };
  } catch (error) {
    if (error instanceof ProviderError) return { ok: false, error: error.message };
    throw error;
  }
}

