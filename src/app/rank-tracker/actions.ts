"use server";

import { revalidatePath } from "next/cache";
import { trackKeyword, untrackKeyword } from "@/application/rank-tracker";
import type { Tried } from "@/domain/tried";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";

const paths = () => {
  revalidatePath("/rank-tracker");
  revalidatePath("/keywords");
};

export async function trackAction(_previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const tracked = await trackKeyword(db(), seat.workspaceId, String(form.get("site") ?? ""), String(form.get("keyword") ?? ""));
  paths();
  return tracked;
}

export async function untrackAction(siteId: string, keywordId: number): Promise<Tried> {
  const seat = await currentSeat();
  const untracked = await untrackKeyword(db(), seat.workspaceId, siteId, keywordId);
  paths();
  return untracked;
}
