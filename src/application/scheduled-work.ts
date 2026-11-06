import type { Database } from "@/infrastructure/db/client";
import { site } from "@/infrastructure/db/schema/search";

export interface ScheduledWork {
  /** With no site, there's nothing to read and nothing to wake the database for. */
  hasSites: boolean;
}

/** What the scheduled jobs have to do, across every workspace. Trusted path: it only ever says yes or no. */
export async function whatIsScheduled(db: Database): Promise<ScheduledWork> {
  const [any] = await db.select({ id: site.id }).from(site).limit(1);
  return { hasSites: Boolean(any) };
}
