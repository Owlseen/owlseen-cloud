import { asc, eq } from "drizzle-orm";
import { managesSettings, NOT_A_MANAGER_OF_SETTINGS } from "@/domain/team";
import { reachOfProperty, type Engine } from "@/domain/search";
import type { Tried } from "@/domain/tried";
import { isRefusal, ProviderError } from "@/infrastructure/connectors/http";
import type { Database } from "@/infrastructure/db/client";
import { site } from "@/infrastructure/db/schema/search";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { scheduledWorkChanged } from "@/infrastructure/scheduling/scheduled-work";
import { connectionsWith, markFailing, type OpenedConnection } from "./connections";
import type { SearchFigures, SearchProperty } from "./ports";
import type { Services } from "./services";
import { roleIn } from "./team";

export type SiteRow = typeof site.$inferSelect;

export const sitesOf = (db: Database, workspaceId: string): Promise<SiteRow[]> => withWorkspace(db, workspaceId, (tx) => tx.select().from(site).orderBy(asc(site.name)));

/** Whether this looks like an id: what comes from an address shouldn't reach the database as a failed cast. */
export const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** One of this workspace's sites; row-level security answers for any other. */
export async function siteIn(db: Database, workspaceId: string, siteId: string): Promise<SiteRow | undefined> {
  if (!isUuid(siteId)) return undefined;
  const [found] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(site).where(eq(site.id, siteId)));
  return found;
}

export const propertyFor = (row: Pick<SiteRow, "googleProperty" | "bingSite">, engine: Engine) => (engine === "google" ? row.googleProperty : row.bingSite);

export interface AvailableSite {
  domain: string;
  googleProperty: string | null;
  bingSite: string | null;
  /** Already followed here, on every engine that sees it. */
  added: boolean;
}

/** The property covering most of the domain is the one to read, whichever order Google lists them in. */
const betterProperty = (known: string | null, found: string) => (known !== null && reachOfProperty(known) <= reachOfProperty(found) ? known : found);

function merged(found: { engine: Engine; properties: SearchProperty[] }[]): Map<string, Omit<AvailableSite, "added">> {
  const byDomain = new Map<string, Omit<AvailableSite, "added">>();
  for (const { engine, properties } of found) {
    for (const { id, domain } of properties) {
      const known = byDomain.get(domain) ?? { domain, googleProperty: null, bingSite: null };
      if (engine === "google") known.googleProperty = betterProperty(known.googleProperty, id);
      else known.bingSite = known.bingSite ?? id;
      byDomain.set(domain, known);
    }
  }
  return byDomain;
}

/** Whether there's nothing left to add: an engine connected since a site was added still has to be. */
const isCovered = (followed: SiteRow | undefined, { googleProperty, bingSite }: Omit<AvailableSite, "added">) => Boolean(followed) && (!googleProperty || Boolean(followed?.googleProperty)) && (!bingSite || Boolean(followed?.bingSite));

/** What one account can see. An account whose access has ended is said on its connection. */
async function propertiesSeenBy(services: Services, workspaceId: string, { client, row }: OpenedConnection) {
  const source = client as SearchFigures;
  try {
    return { engine: source.engine, properties: await source.properties() };
  } catch (error) {
    if (isRefusal(error) && error.status === 401) await markFailing(services, workspaceId, row.id, error.message);
    throw error;
  }
}

/** What the accounts answered: one that can't answer doesn't hide what the others see, unless none can. */
async function propertiesSeen(services: Services, workspaceId: string) {
  const connections = await connectionsWith(services, workspaceId, "search_figures");
  const answers = await Promise.allSettled(connections.map((opened) => propertiesSeenBy(services, workspaceId, opened)));
  const found = answers.flatMap((answer) => (answer.status === "fulfilled" ? [answer.value] : []));
  const failure = answers.find((answer) => answer.status === "rejected");
  if (found.length === 0 && failure) throw failure.reason;
  return found;
}

/** What the connected accounts can see, one row per domain, across engines. It asks them, so it's for the sites screen and not for a chart. */
export async function sitesAvailable(services: Services, workspaceId: string): Promise<AvailableSite[]> {
  const found = await propertiesSeen(services, workspaceId);
  const followed = new Map((await sitesOf(services.db, workspaceId)).map((row) => [row.name, row]));
  return [...merged(found).values()].map((available) => ({ ...available, added: isCovered(followed.get(available.domain), available) })).sort((a, b) => a.domain.localeCompare(b.domain));
}

const availableOrRefusal = (services: Services, workspaceId: string): Promise<AvailableSite[] | string> =>
  sitesAvailable(services, workspaceId).catch((error) => {
    if (error instanceof ProviderError) return error.message;
    throw error;
  });

/** Follows these domains, as the connected accounts name them. A site already followed gets any engine it was missing, read from the start like a new one; what an account that's away called it stays. */
export async function addSites(services: Services, workspaceId: string, userId: string, domains: readonly string[]): Promise<Tried> {
  if (!managesSettings(await roleIn(services.db, workspaceId, userId))) return { ok: false, error: NOT_A_MANAGER_OF_SETTINGS };
  const wanted = new Set(domains);
  const available = await availableOrRefusal(services, workspaceId);
  if (typeof available === "string") return { ok: false, error: available };
  const chosen = available.filter(({ domain }) => wanted.has(domain));
  if (chosen.length === 0) return { ok: false, error: "None of your connected accounts can see that site." };
  await withWorkspace(services.db, workspaceId, async (tx) => {
    for (const { domain, googleProperty, bingSite } of chosen) {
      await tx
        .insert(site)
        .values({ name: domain, googleProperty, bingSite })
        .onConflictDoUpdate({ target: [site.workspaceId, site.name], set: { ...(googleProperty && { googleProperty }), ...(bingSite && { bingSite }), lastSyncedAt: null } });
    }
  });
  scheduledWorkChanged();
  return { ok: true, said: chosen.length === 1 ? `Added ${chosen[0].domain}. Its figures arrive with the next sync.` : `Added ${chosen.length} sites. Their figures arrive with the next sync.` };
}

/** Stops following a site, and forgets everything stored about it. */
export async function removeSite(services: Services, workspaceId: string, userId: string, siteId: string): Promise<Tried> {
  if (!managesSettings(await roleIn(services.db, workspaceId, userId))) return { ok: false, error: NOT_A_MANAGER_OF_SETTINGS };
  const removed = isUuid(siteId) ? await withWorkspace(services.db, workspaceId, (tx) => tx.delete(site).where(eq(site.id, siteId)).returning({ name: site.name })) : [];
  if (removed.length === 0) return { ok: false, error: "There’s no such site here." };
  scheduledWorkChanged();
  return { ok: true, said: `Removed ${removed[0].name} and what was stored about it.` };
}
