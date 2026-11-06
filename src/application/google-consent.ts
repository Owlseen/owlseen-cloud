import { and, eq, ne } from "drizzle-orm";
import { connectorOf } from "@/domain/connectors";
import { managesSettings, NOT_A_MANAGER_OF_SETTINGS } from "@/domain/team";
import type { Tried } from "@/domain/tried";
import { ProviderError } from "@/infrastructure/connectors/http";
import { consentAddress, exchangeConsentCode } from "@/infrastructure/connectors/google";
import { open, seal, signedValue, valueSigned } from "@/infrastructure/crypto/secrets";
import { connection } from "@/infrastructure/db/schema/connections";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { scheduledWorkChanged } from "@/infrastructure/scheduling/scheduled-work";
import { CANT_OPEN, openedFields, sitesGoAgain } from "./connections";
import type { Services } from "./services";
import { isUuid } from "./sites";
import { roleIn } from "./team";

const CONSENT_LASTS_MS = 15 * 60_000;
const GONE = "This connection no longer exists.";
const EXPIRED = "That took too long, or came from somewhere else. Try again from the connection’s page.";

interface ConsentState {
  connectionId: string;
  workspaceId: string;
  userId: string;
  expiresAt: number;
}

const redirectOf = (services: Pick<Services, "settings">) => new URL(connectorOf("google")?.consentCallback as string, services.settings.BETTER_AUTH_URL).toString();

/** The redirect address to give Google, for the connection's page to show. */
export const googleRedirectAddress = redirectOf;

async function managedRow(services: Services, workspaceId: string, userId: string, connectionId: string) {
  if (!managesSettings(await roleIn(services.db, workspaceId, userId))) return { error: NOT_A_MANAGER_OF_SETTINGS };
  // It comes from an address: what can't be an id shouldn't reach the database as a failed cast.
  if (!isUuid(connectionId)) return { error: GONE };
  const [row] = await withWorkspace(services.db, workspaceId, (tx) => tx.select().from(connection).where(eq(connection.id, connectionId)));
  return row?.kind === "google" ? { row } : { error: GONE };
}

/** Where to send a member who manages this workspace so they can allow access, with a state that says who and which, and can't be altered. */
export async function startGoogleConsent(services: Services, workspaceId: string, userId: string, connectionId: string): Promise<{ address: string } | { error: string }> {
  const found = await managedRow(services, workspaceId, userId, connectionId);
  if ("error" in found) return { error: found.error as string };
  const fields = openedFields(services, found.row);
  if (!fields) return { error: CANT_OPEN };
  const state: ConsentState = { connectionId, workspaceId, userId, expiresAt: services.now().getTime() + CONSENT_LASTS_MS };
  const signed = signedValue(JSON.stringify(state), services.settings.OWLSEEN_SECRETS_KEY as string);
  return { address: consentAddress(fields.clientId, redirectOf(services), signed) };
}

function stateFrom(services: Services, signed: string, userId: string): ConsentState | null {
  const value = valueSigned(signed, services.settings.OWLSEEN_SECRETS_KEY as string);
  if (!value) return null;
  const state = JSON.parse(value) as ConsentState;
  return state.expiresAt > services.now().getTime() && state.userId === userId ? state : null;
}

async function exchange(services: Services, fields: Record<string, string>, code: string): Promise<{ refreshToken: string; account: string | null } | { error: string }> {
  try {
    return await exchangeConsentCode({ fetch: services.fetch, fields }, code, redirectOf(services));
  } catch (error) {
    if (error instanceof ProviderError) return { error: error.message };
    throw error;
  }
}

/** What Google sent back, for the member who started it: the lasting token is sealed with the rest, and the connection is named after the account. */
export async function finishGoogleConsent(services: Services, signedState: string, code: string, userId: string): Promise<Tried> {
  const state = stateFrom(services, signedState, userId);
  if (!state) return { ok: false, error: EXPIRED };
  const found = await managedRow(services, state.workspaceId, userId, state.connectionId);
  if ("error" in found) return { ok: false, error: found.error as string };
  const fields = openedFields(services, found.row);
  if (!fields) return { ok: false, error: CANT_OPEN };
  const answer = await exchange(services, fields, code);
  if ("error" in answer) return { ok: false, error: answer.error };
  const key = services.settings.OWLSEEN_SECRETS_KEY;
  const label = answer.account ?? found.row.label;
  const sealedCredentials = seal({ ...open(found.row.sealedCredentials, key), refreshToken: answer.refreshToken, account: label }, key);
  await withWorkspace(services.db, state.workspaceId, async (tx) => {
    // The same account allowed again through a new client: this connection takes the place of the one it had.
    await tx.delete(connection).where(and(eq(connection.kind, "google"), eq(connection.label, label), ne(connection.id, state.connectionId)));
    await tx.update(connection).set({ sealedCredentials, label, status: "connected", lastError: null, checkedAt: services.now() }).where(eq(connection.id, state.connectionId));
  });
  await sitesGoAgain(services, state.workspaceId, "google");
  scheduledWorkChanged();
  return { ok: true, said: `Connected as ${label}.` };
}
