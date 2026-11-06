"use server";

import { revalidatePath } from "next/cache";
import { inspectPageAs, submitSitemap } from "@/application/indexing";
import { ENGINES, type Engine } from "@/domain/search";
import type { Tried } from "@/domain/tried";
import { currentSeat } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";

const engineFrom = (value: FormDataEntryValue | null): Engine => (ENGINES.includes(value as Engine) ? (value as Engine) : "google");

export async function submitSitemapAction(siteId: string, _previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const submitted = await submitSitemap(appServices(), seat.workspaceId, seat.userId, siteId, engineFrom(form.get("engine")), String(form.get("url") ?? "").trim());
  revalidatePath("/indexing");
  return submitted;
}

export async function inspectAction(siteId: string, _previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const inspected = await inspectPageAs(appServices(), seat.workspaceId, seat.userId, siteId, String(form.get("url") ?? "").trim());
  if (!inspected.ok) return inspected;
  const { verdict, coverage } = inspected.inspection;
  return { ok: true, said: `${verdict === "PASS" ? "Indexed" : "Not indexed"}${coverage ? `: ${coverage}` : ""}.` };
}
