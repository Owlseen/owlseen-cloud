import type { Services } from "@/application/services";
import type { Member, Seat } from "@/infrastructure/auth/session";
import type { Database } from "@/infrastructure/db/client";

/**
 * What a screen or a route gets from the request, set by each test: who's in front of it, and which
 * database and network it talks to. Everything below that runs for real, on a real Postgres.
 */
export const atTheScreen = {
  seat: null as Seat | null,
  member: null as Member | null,
  services: null as Services | null,
  db: null as Database | null,
  revalidated: [] as string[],
  entered: [] as string[],
  forgotten: 0,
};

/** What `redirect` and `notFound` throw in a test, so that a test can say where a request ended up. */
export class Redirected extends Error {
  constructor(readonly to: string) {
    super(`Redirected to ${to}`);
  }
}

export const form = (fields: Record<string, string | string[]>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) for (const one of [value].flat()) data.append(name, one);
  return data;
};

/** Where a function that ends in a redirect sends the request. */
export async function whereItGoes(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof Redirected) return error.to;
    throw error;
  }
  throw new Error("It didn't redirect.");
}
