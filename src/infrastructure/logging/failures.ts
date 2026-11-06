import { DrizzleQueryError } from "drizzle-orm";

/** A failed query keeps its statement and what's safe of its cause (see db/query-errors): the rest of the words stay out, as any error's can repeat a value. */
function kindOf(error: unknown): string {
  if (error instanceof DrizzleQueryError) {
    const { code, message } = error.cause as Error & { code?: unknown };
    return `a query failed (${typeof code === "string" ? code : "no code"}): ${message}`;
  }
  return error instanceof Error ? error.name : "something that isn't an error";
}

/** A failure on our side, for whoever reads the platform's logs: what was being done and what kind of failure, never a value. */
export function logFailure(doing: string, error: unknown): void {
  console.error(`${doing}: ${kindOf(error)}`);
}
