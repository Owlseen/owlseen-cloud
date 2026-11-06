import { runIndexChecks } from "@/application/indexing";
import { syncDueSites } from "@/application/sync";
import { appServices } from "@/infrastructure/services";
import { cronRefusal, scheduledWork } from "../scheduled-work";

export const maxDuration = 300;

/** Stops short of the function's limit: what's left waits for the next run. */
const RUN_MS = 270_000;
/** What reading may take of it, so that asking about pages gets its time on a day there's a lot to read. See docs/01-daily-read.md. */
const READING_MS = 200_000;

/**
 * Reads what's due from the engines, then asks about pages' index status with what time is left. It
 * runs several times each morning, so a large workspace finishes across runs; once everything is read
 * for the day, a run only asks which sites and pages are due. With no site at all, it doesn't wake the database.
 */
export async function GET(request: Request) {
  const refused = cronRefusal(request);
  if (refused) return refused;
  if (!(await scheduledWork()).hasSites) return Response.json({ idle: true });
  const services = appServices();
  const start = services.now().getTime();
  const sync = await syncDueSites(services, start + READING_MS);
  const indexing = await runIndexChecks(services, start + RUN_MS);
  return Response.json({ sync, indexing });
}
