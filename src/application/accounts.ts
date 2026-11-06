import { isRefusal, ProviderError } from "@/infrastructure/connectors/http";
import type { Capability } from "@/domain/connectors";
import { connectionsWith, markFailing, markWorking, type OpenedConnection } from "./connections";
import type { Services } from "./services";

/** A job's way to a workspace's accounts: opened once for a run, however many sites it reads. */
export function accountsOnce(services: Services, capability: Capability): (workspaceId: string) => Promise<OpenedConnection[]> {
  const opened = new Map<string, Promise<OpenedConnection[]>>();
  return (workspaceId) => {
    const known = opened.get(workspaceId) ?? connectionsWith(services, workspaceId, capability);
    opened.set(workspaceId, known);
    return known;
  };
}

/**
 * Asks a workspace's accounts on one engine in turn, until one answers. An account without this site
 * refuses it, which says nothing about the site or that account, so only refused credentials mark a
 * connection as failing. When all refuse, the refusal that says most is what's thrown.
 */
export async function askInTurn<T>(services: Services, workspaceId: string, accounts: readonly OpenedConnection[], ask: (account: OpenedConnection) => Promise<T>): Promise<T> {
  const refusals: ProviderError[] = [];
  for (const account of accounts) {
    try {
      const answer = await ask(account);
      if (account.row.status === "failing") await markWorking(services, workspaceId, account.row.id);
      return answer;
    } catch (error) {
      if (!isRefusal(error)) throw error;
      if (error.status === 401) await markFailing(services, workspaceId, account.row.id, error.message);
      refusals.push(error);
    }
  }
  throw refusals.find(({ status }) => status === 401) ?? refusals[0];
}
