import { NextResponse } from "next/server";
import { startGoogleConsent } from "@/application/google-consent";
import { currentSeat } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";

/** Sends a member who manages this workspace to Google, to allow access for this connection. */
export async function GET(request: Request) {
  const seat = await currentSeat();
  const url = new URL(request.url);
  const started = await startGoogleConsent(appServices(), seat.workspaceId, seat.userId, url.searchParams.get("connection") ?? "");
  if ("error" in started) return NextResponse.redirect(new URL(`/connections/google?${new URLSearchParams({ error: started.error })}`, url));
  return NextResponse.redirect(started.address);
}
