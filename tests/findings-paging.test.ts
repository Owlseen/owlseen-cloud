import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";
import type { KeywordsAndPages } from "@/application/ports";
import { adapterOf } from "@/infrastructure/connectors";
import { DRIZZLE_CASING, schema, type Database } from "@/infrastructure/db/client";
import { site } from "@/infrastructure/db/schema/search";

const FROM = "2026-08-07";
const TO = "2026-11-05";
const ROWS_A_DAY = 2_000;

const daysBetween = (from: string, to: string) => {
  const days: string[] = [];
  for (let at = new Date(`${from}T00:00:00Z`); at <= new Date(`${to}T00:00:00Z`); at = new Date(at.getTime() + 86_400_000)) days.push(at.toISOString().slice(0, 10));
  return days;
};

/** Search Console as its reference says it answers when grouping by date: oldest first, a page at a time. */
const searchConsole = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input.toString();
  if (url.includes("oauth2.googleapis.com")) return Response.json({ access_token: "token" });
  const { startDate, endDate, rowLimit, startRow } = JSON.parse(String(init?.body)) as { startDate: string; endDate: string; rowLimit: number; startRow: number };
  const all = daysBetween(startDate, endDate).flatMap((day) => Array.from({ length: ROWS_A_DAY }, (_, index) => ({ keys: [`word ${index}`, day], clicks: 1, impressions: 5, position: 4 })));
  return Response.json({ rows: all.slice(startRow, startRow + rowLimit) });
}) as typeof fetch;

describe("a property with more rows than four pages hold", () => {
  it("doesn't silently lose its most recent days", async () => {
    const client = adapterOf("google")({ fields: { clientId: "c", clientSecret: "s", refreshToken: "r" }, fetch: searchConsole, wait: async () => {} }) as unknown as KeywordsAndPages;
    const rows = [];
    for await (const { days: found } of client.keywordSlices("sc-domain:acme.example", FROM, TO)) rows.push(...found);
    const days = [...new Set(rows.map(({ day }) => day))].sort();
    expect(days[0]).toBe(FROM);
    expect(rows).toHaveLength(ROWS_A_DAY * daysBetween(FROM, TO).length);
    expect(days.at(-1)).toBe(TO);
  });
});

describe("what isn't forced", () => {
  it("leaves a plain owner, without BYPASSRLS, its trusted path: forcing it would read nothing", async () => {
    const pg = new PGlite();
    await pg.exec(`CREATE ROLE plain_owner LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS; GRANT ALL ON DATABASE postgres TO plain_owner; GRANT ALL ON SCHEMA public TO plain_owner; SET ROLE plain_owner;`);
    const db = drizzle(pg, { schema, casing: DRIZZLE_CASING }) as unknown as Database;
    await migrate(db as never, { migrationsFolder: "src/infrastructure/db/migrations" });
    await pg.exec(`INSERT INTO workspace (id, name, slug) VALUES ('00000000-0000-4000-8000-000000000001', 'A', 'a'); INSERT INTO site (workspace_id, name) VALUES ('00000000-0000-4000-8000-000000000001', 'acme.example');`);
    expect(await db.select({ name: site.name }).from(site)).toHaveLength(1);
  }, 300_000);
});
