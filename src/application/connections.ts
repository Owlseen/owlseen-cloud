import { and, eq, isNotNull, sql } from "drizzle-orm";
import { CONNECTORS, connectorOf, readFields, type Capability, type Connector, type ConnectorKind } from "@/domain/connectors";
import { managesSettings, NOT_A_MANAGER_OF_SETTINGS } from "@/domain/team";
import type { AdapterClient } from "@/infrastructure/connectors/adapter";
import { adapterOf } from "@/infrastructure/connectors";
import { open, seal, type Credentials } from "@/infrastructure/crypto/secrets";
import { connection } from "@/infrastructure/db/schema/connections";
import { site } from "@/infrastructure/db/schema/search";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { logFailure } from "@/infrastructure/logging/failures";
import type { Services } from "./services";
import { roleIn } from "./team";

/** A connection as a member sees it: never its credentials. */
export interface ConnectionView {
  id: string;
  kind: ConnectorKind;
  name: string;
  label: string;
  status: "connected" | "failing";
  capabilities: readonly Capability[];
  checkedAt: Date | null;
  lastError: string | null;
  /** Its fields are saved, but a member still has to allow access at the service. */
  awaitsConsent: boolean;
}

type ConnectionRow = typeof connection.$inferSelect;

export const fieldsOf = (services: Pick<Services, "settings">, row: ConnectionRow): Credentials => ({ ...row.settings, ...open(row.sealedCredentials, services.settings.OWLSEEN_SECRETS_KEY) });

export const CANT_OPEN = "These credentials can’t be opened here: connect it again.";

/** A row's fields, or null when its seal won't open, sealed with another key or damaged: one broken row mustn't stop a whole workspace, or a job across all of them. */
export function openedFields(services: Pick<Services, "settings">, row: ConnectionRow): Credentials | null {
  try {
    return fieldsOf(services, row);
  } catch (error) {
    logFailure(`Opening connection ${row.id}`, error);
    return null;
  }
}

const awaitsConsent = (connector: Connector | undefined, fields: Credentials | null) => Boolean(connector?.consentCallback) && fields !== null && !fields.refreshToken;

export function viewOf(services: Pick<Services, "settings">, row: ConnectionRow): ConnectionView {
  const connector = connectorOf(row.kind) as Connector;
  const fields = openedFields(services, row);
  return {
    id: row.id,
    kind: connector.kind,
    name: connector.name,
    label: row.label,
    status: fields ? row.status : "failing",
    capabilities: connector.capabilities,
    checkedAt: row.checkedAt,
    lastError: fields ? row.lastError : CANT_OPEN,
    awaitsConsent: awaitsConsent(connector, fields),
  };
}

export const connectorsOffered = (): readonly Connector[] => CONNECTORS;

export async function connectionsOf(services: Services, workspaceId: string): Promise<ConnectionView[]> {
  const rows = await withWorkspace(services.db, workspaceId, (tx) => tx.select().from(connection).orderBy(connection.kind, connection.label));
  return rows.filter((row) => connectorOf(row.kind)).map((row) => viewOf(services, row));
}

/** Connections whose credentials no longer work, or can't be opened: nothing is being read through them, and silence from their sites means only that. */
export async function connectionsNotWorking(services: Services, workspaceId: string): Promise<ConnectionView[]> {
  return (await connectionsOf(services, workspaceId)).filter(({ status }) => status === "failing");
}

export type Connected = { ok: true; connection: ConnectionView } | { ok: false; error: string };

const isManager = async (services: Services, workspaceId: string, userId: string) => managesSettings(await roleIn(services.db, workspaceId, userId));

/** A check never throws: a service down or a refused key is an answer to show. */
export async function safeCheck(client: AdapterClient) {
  try {
    return await client.check();
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "The service didn’t answer." };
  }
}

const contextFor = (services: Services, fields: Record<string, string>) => ({ fields, fetch: services.fetch, wait: services.wait });

/** Secret fields are sealed; the others stay readable, for the screens. */
function splitFields(connector: Connector, fields: Record<string, string>): { secrets: Credentials; settings: Record<string, string> } {
  const secretKeys = new Set(connector.fields.filter((field) => field.secret).map((field) => field.key));
  const entries = Object.entries(fields);
  return { secrets: Object.fromEntries(entries.filter(([key]) => secretKeys.has(key))), settings: Object.fromEntries(entries.filter(([key]) => !secretKeys.has(key))) };
}

/**
 * Connects a service from what the member typed: checked against the service first, so a wrong key
 * is said at once rather than at the first read. Typing it again replaces the key and keeps the row,
 * and what a member doesn't type again, such as a lasting token, stays as it was.
 */
export async function connectWithFields(services: Services, workspaceId: string, userId: string, kind: string, values: Record<string, unknown>): Promise<Connected> {
  if (!(await isManager(services, workspaceId, userId))) return { ok: false, error: NOT_A_MANAGER_OF_SETTINGS };
  const connector = connectorOf(kind);
  if (!connector) return { ok: false, error: "There’s no such service." };
  if (!services.settings.OWLSEEN_SECRETS_KEY) return { ok: false, error: "This instance can’t seal credentials yet: its OWLSEEN_SECRETS_KEY isn’t set." };
  const read = readFields(connector, values);
  if (!read.ok) return { ok: false, error: `Missing: ${read.missing.join(", ")}.` };
  const check = await safeCheck(adapterOf(connector.kind)(contextFor(services, read.values)));
  if (!check.ok) return { ok: false, error: check.detail };
  const { secrets, settings } = splitFields(connector, read.values);
  const label = check.label ?? connector.name;
  const earlier = (await withWorkspace(services.db, workspaceId, (tx) => tx.select().from(connection).where(eq(connection.kind, connector.kind)))).find((row) => row.label === label);
  const credentials = { ...(earlier ? openedFields(services, earlier) : {}), ...secrets };
  const row = await saveConnection(services, workspaceId, { kind: connector.kind, label, credentials, settings, userId });
  if (!awaitsConsent(connector, fieldsOf(services, row))) await sitesGoAgain(services, workspaceId, connector.kind);
  return { ok: true, connection: viewOf(services, row) };
}

/** A connection that works again: what its sites said no longer holds, and they're read first. */
export async function sitesGoAgain(services: Services, workspaceId: string, kind: ConnectorKind): Promise<void> {
  const property = kind === "google" ? site.googleProperty : site.bingSite;
  await withWorkspace(services.db, workspaceId, (tx) => tx.update(site).set({ lastSyncError: null, lastReadFailed: false, lastSyncedAt: null }).where(and(isNotNull(property), isNotNull(site.lastSyncError))));
}

interface NewConnection {
  kind: ConnectorKind;
  label: string;
  credentials: Credentials;
  settings: Record<string, string>;
  userId: string;
}

async function saveConnection(services: Services, workspaceId: string, created: NewConnection): Promise<ConnectionRow> {
  const sealedCredentials = seal(created.credentials, services.settings.OWLSEEN_SECRETS_KEY);
  const now = services.now();
  return withWorkspace(services.db, workspaceId, async (tx) => {
    const [row] = await tx
      .insert(connection)
      .values({ kind: created.kind, label: created.label, sealedCredentials, settings: created.settings, connectedBy: created.userId, checkedAt: now })
      .onConflictDoUpdate({
        target: [connection.workspaceId, connection.kind, connection.label],
        set: { sealedCredentials, settings: created.settings, status: "connected", lastError: null, checkedAt: now, updatedAt: sql`now()` },
      })
      .returning();
    return row;
  });
}

/** Asks the service again whether the connection still works, and records the answer. */
export async function checkConnection(services: Services, workspaceId: string, connectionId: string): Promise<ConnectionView | null> {
  const [found] = await withWorkspace(services.db, workspaceId, (tx) => tx.select().from(connection).where(eq(connection.id, connectionId)));
  if (!found) return null;
  const opened = openedFields(services, found) && clientOf(services, found);
  const check = opened ? await safeCheck(opened.client) : { ok: false, detail: CANT_OPEN };
  const [row] = await withWorkspace(services.db, workspaceId, (tx) =>
    tx
      .update(connection)
      .set({ status: check.ok ? "connected" : "failing", lastError: check.ok ? null : check.detail, checkedAt: services.now() })
      .where(eq(connection.id, connectionId))
      .returning(),
  );
  return viewOf(services, row);
}

/** Forgets a connection and its credentials; what it brought in stays. */
export async function disconnect(services: Services, workspaceId: string, userId: string, connectionId: string): Promise<boolean> {
  if (!(await isManager(services, workspaceId, userId))) return false;
  const deleted = await withWorkspace(services.db, workspaceId, (tx) => tx.delete(connection).where(eq(connection.id, connectionId)).returning({ id: connection.id }));
  return deleted.length > 0;
}

export interface OpenedConnection {
  row: ConnectionRow;
  connector: Connector;
  client: AdapterClient;
}

export function clientOf(services: Services, row: ConnectionRow): OpenedConnection {
  const connector = connectorOf(row.kind) as Connector;
  return { row, connector, client: adapterOf(connector.kind)(contextFor(services, fieldsOf(services, row))) };
}

/**
 * The workspace's connections that can do this and are allowed to, opened; failing ones too, since the
 * service may be back and a failure gets said when it's used. One that can't be opened is said on its row and left out.
 */
export async function connectionsWith(services: Services, workspaceId: string, capability: Capability): Promise<OpenedConnection[]> {
  const rows = await withWorkspace(services.db, workspaceId, (tx) => tx.select().from(connection).orderBy(connection.createdAt));
  const able = rows.filter((row) => (connectorOf(row.kind)?.capabilities as readonly Capability[] | undefined)?.includes(capability));
  const opened: OpenedConnection[] = [];
  for (const row of able) {
    const fields = openedFields(services, row);
    if (!fields) await markFailing(services, workspaceId, row.id, CANT_OPEN);
    else if (!awaitsConsent(connectorOf(row.kind), fields)) opened.push(clientOf(services, row));
  }
  return opened;
}

/** Records that the service answered again: a connection doesn't stay marked as failing once it works. */
export async function markWorking(services: Services, workspaceId: string, connectionId: string): Promise<void> {
  await withWorkspace(services.db, workspaceId, (tx) => tx.update(connection).set({ status: "connected", lastError: null, checkedAt: services.now() }).where(eq(connection.id, connectionId)));
}

/** Records that the service refused the credentials, so the connections page says so too. */
export async function markFailing(services: Services, workspaceId: string, connectionId: string, why: string): Promise<void> {
  await withWorkspace(services.db, workspaceId, (tx) => tx.update(connection).set({ status: "failing", lastError: why }).where(eq(connection.id, connectionId)));
}
