"use server";

import { revalidatePath } from "next/cache";
import { removeSiteGroup, saveSiteGroup } from "@/application/site-groups";
import { addSites, removeSite } from "@/application/sites";
import type { Tried } from "@/domain/tried";
import { currentSeat } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";

export async function addSitesAction(_previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const added = await addSites(appServices(), seat.workspaceId, seat.userId, form.getAll("domain").map(String));
  revalidatePath("/sites");
  return added;
}

export async function removeSiteAction(siteId: string): Promise<Tried> {
  const seat = await currentSeat();
  const removed = await removeSite(appServices(), seat.workspaceId, seat.userId, siteId);
  revalidatePath("/sites");
  return removed;
}

export async function saveGroupAction(_previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const saved = await saveSiteGroup(appServices().db, seat.workspaceId, seat.userId, String(form.get("name") ?? ""), form.getAll("site").map(String));
  revalidatePath("/sites");
  return saved;
}

export async function removeGroupAction(groupId: string): Promise<Tried> {
  const seat = await currentSeat();
  const removed = await removeSiteGroup(appServices().db, seat.workspaceId, seat.userId, groupId);
  revalidatePath("/sites");
  return removed;
}
