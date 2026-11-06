import { managesSettings, NOT_A_MANAGER_OF_SETTINGS } from "@/domain/team";
import type { Tried } from "@/domain/tried";
import { checkConnection } from "./connections";
import type { Services } from "./services";
import { roleIn } from "./team";

/** Asks the service whether the connection still works, and says so. */
export async function tryCheck(services: Services, workspaceId: string, userId: string, connectionId: string): Promise<Tried> {
  if (!managesSettings(await roleIn(services.db, workspaceId, userId))) return { ok: false, error: NOT_A_MANAGER_OF_SETTINGS };
  const checked = await checkConnection(services, workspaceId, connectionId);
  if (!checked) return { ok: false, error: "This connection no longer exists." };
  return checked.status === "connected" ? { ok: true, said: `${checked.label} answers.` } : { ok: false, error: checked.lastError ?? "The service didn’t answer." };
}
