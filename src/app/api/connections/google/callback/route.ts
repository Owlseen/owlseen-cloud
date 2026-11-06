import { NextResponse } from "next/server";
import { finishGoogleConsent } from "@/application/google-consent";
import { currentSeat } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";

const REFUSED = "Google wasn’t given access: nothing changed.";

/** Where Google sends a member back to. Whatever it says, they land on the connection's page, which says it in words. */
export async function GET(request: Request) {
  const seat = await currentSeat();
  const url = new URL(request.url);
  const [code, state] = [url.searchParams.get("code"), url.searchParams.get("state")];
  const tried = code && state ? await finishGoogleConsent(appServices(), state, code, seat.userId) : { ok: false as const, error: REFUSED };
  const said: Record<string, string> = tried.ok ? { said: tried.said } : { error: tried.error };
  return NextResponse.redirect(new URL(`/connections/google?${new URLSearchParams(said)}`, url));
}
