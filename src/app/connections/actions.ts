"use server";

import { revalidatePath } from "next/cache";
import { tryCheck } from "@/application/connection-use";
import { connectWithFields, disconnect } from "@/application/connections";
import type { Tried } from "@/domain/tried";
import { currentSeat } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";

export interface ConnectState {
  error?: string;
  connected?: string;
}

/** Connects a service from what the member typed; the service answers before anything is saved. */
export async function connectAction(kind: string, _previous: ConnectState, formData: FormData): Promise<ConnectState> {
  const seat = await currentSeat();
  const result = await connectWithFields(appServices(), seat.workspaceId, seat.userId, kind, Object.fromEntries(formData));
  if (!result.ok) return { error: result.error };
  revalidatePath(`/connections/${kind}`);
  return { connected: result.connection.label };
}

export async function checkAction(kind: string, connectionId: string): Promise<Tried> {
  const seat = await currentSeat();
  const tried = await tryCheck(appServices(), seat.workspaceId, seat.userId, connectionId);
  revalidatePath(`/connections/${kind}`);
  return tried;
}

export async function disconnectAction(kind: string, connectionId: string): Promise<void> {
  const seat = await currentSeat();
  await disconnect(appServices(), seat.workspaceId, seat.userId, connectionId);
  revalidatePath(`/connections/${kind}`);
}
