import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createApiKey } from "@/application/api-keys";
import { runIndexChecks } from "@/application/indexing";
import { inviteToWorkspace } from "@/application/invitations";
import { trackKeyword } from "@/application/rank-tracker";
import { syncDueSites } from "@/application/sync";
import { saveSiteGroup } from "@/application/site-groups";
import type { Database } from "@/infrastructure/db/client";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { connectBing, connectGoogle, followSite, GOOGLE_TOKEN, googleProperty, INSPECT, inspected, NOW, testServices } from "./support/search";

/**
 * Isolation is checked against the database itself, not a list kept by hand: a new table that isn't
 * in `TRUSTED_TABLES` and lacks row-level security, a policy, a grant or its rows here fails this file.
 */

/** Read before any workspace is known, or owned by Better Auth. Everything else belongs to a workspace. */
const TRUSTED_TABLES = ["account", "jwks", "member", "oauth_access_token", "oauth_client", "oauth_client_assertion", "oauth_client_resource", "oauth_consent", "oauth_refresh_token", "oauth_resource", "rate_limit", "session", "user", "verification", "workspace"];

/** The tables this product is made of: a name dropped from the database, or a check that sees none of them, fails here. */
const WORKSPACE_TABLES = ["api_key", "connection", "index_check", "invitation", "keyword", "keyword_day", "page", "page_day", "search_day", "site", "site_group", "site_group_member", "sitemap", "tracked_keyword"];

const FAR_AWAY = NOW.getTime() + 3_600_000;
const PROPERTY = "sc-domain:acme.example";

let db: Database;
let tables: string[];
let mine: Awaited<ReturnType<typeof createTestWorkspace>>;
let theirs: Awaited<ReturnType<typeof createTestWorkspace>>;

const rowsOf = (result: unknown) => (result as { rows: Record<string, unknown>[] }).rows;
const query = async (statement: ReturnType<typeof sql>, on: Database = db) => rowsOf(await on.execute(statement));

const ONE_READ = {
  totals: [{ keys: ["2026-11-01"], clicks: 3, impressions: 60, position: 7.5 }],
  keywords: [{ keys: ["acme pricing", "2026-11-01"], clicks: 2, impressions: 40, position: 4.5 }],
  pages: [{ keys: ["https://acme.example/pricing", "2026-11-01"], clicks: 1, impressions: 20, position: 2.5 }],
  sitemaps: [{ path: "https://acme.example/sitemap.xml" }],
};

/** One workspace's rows in every table it can have them, through what really writes them. */
async function stock(workspaceId: string, userId: string) {
  const { services } = testServices(db, [...googleProperty(PROPERTY, ONE_READ), GOOGLE_TOKEN, { match: INSPECT, json: inspected("PASS") }]);
  await connectGoogle(testServices(db).services, workspaceId, userId);
  await connectBing(testServices(db).services, workspaceId, userId);
  const made = await createApiKey(db, workspaceId, userId, "Key", ["figures:read"]);
  if (!made.ok) throw new Error(made.error);
  await inviteToWorkspace(services, workspaceId, userId, "new@northwind.example", "member");
  const site = await followSite(db, workspaceId);
  const read = await syncDueSites(services, FAR_AWAY);
  if (read.failed > 0) throw new Error("The read failed: nothing to check isolation with");
  await trackKeyword(db, workspaceId, site.id, "acme pricing");
  await saveSiteGroup(db, workspaceId, userId, "Acme's sites", [site.id]);
  await runIndexChecks(services, FAR_AWAY);
}

beforeAll(async () => {
  db = await createTestDatabase();
  mine = await createTestWorkspace(db, "Mine");
  theirs = await createTestWorkspace(db, "Theirs");
  await stock(mine.workspaceId, mine.userId);
  await stock(theirs.workspaceId, theirs.userId);
  const found = await query(sql`select tablename from pg_tables where schemaname = 'public' order by 1`);
  tables = found.map(({ tablename }) => tablename as string).filter((name) => !TRUSTED_TABLES.includes(name));
});

describe("every table that belongs to a workspace", () => {
  it("is found: this file can't pass by looking at nothing", () => {
    expect(tables).toEqual(expect.arrayContaining(WORKSPACE_TABLES));
  });

  it("has row-level security on, and the tenant policy", async () => {
    for (const table of tables) {
      const [state] = await query(sql`select relrowsecurity from pg_class where oid = ${`public.${table}`}::regclass`);
      expect(state.relrowsecurity, `${table} has no row-level security`).toBe(true);
      const policies = await query(sql`select qual, with_check, roles::text as roles from pg_policies where schemaname = 'public' and tablename = ${table}`);
      expect(policies, `${table} has no policy`).toHaveLength(1);
      expect(policies[0].qual, table).toContain("app_workspace_id()");
      expect(policies[0].with_check, table).toContain("app_workspace_id()");
      expect(policies[0].roles, table).toContain("tenant_app");
    }
  });

  it("is granted to the app role, to read and to write", async () => {
    for (const table of tables) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const [{ granted }] = await query(sql`select has_table_privilege('tenant_app', ${`public.${table}`}, ${privilege}) as granted`);
        expect(granted, `${table} has no ${privilege} grant`).toBe(true);
      }
    }
  });

  it("carries the workspace it belongs to", async () => {
    for (const table of tables) {
      const columns = await query(sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table} and column_name = 'workspace_id'`);
      expect(columns, `${table} has no workspace_id`).toHaveLength(1);
    }
  });

  it("shows a workspace its own rows and nobody else's", async () => {
    for (const table of tables) {
      const name = sql.identifier(table);
      for (const [here, there] of [[mine.workspaceId, theirs.workspaceId], [theirs.workspaceId, mine.workspaceId]]) {
        const seen = await withWorkspace(db, here, (tx) => query(sql`select workspace_id from ${name}`, tx));
        expect(seen.length, `${table} has no rows to test with: stock it above`).toBeGreaterThan(0);
        expect(seen.every(({ workspace_id }) => workspace_id === here), `${table} shows another workspace's rows`).toBe(true);
        const [{ count }] = await withWorkspace(db, here, (tx) => query(sql`select count(*)::int as count from ${name} where workspace_id = ${there}`, tx));
        expect(count, `${table} answers about another workspace`).toBe(0);
      }
    }
  });

  it("won't update or delete another workspace's rows", async () => {
    for (const table of tables) {
      const name = sql.identifier(table);
      const [before] = await query(sql`select count(*)::int as count from ${name} where workspace_id = ${theirs.workspaceId}`);
      const updated = await withWorkspace(db, mine.workspaceId, (tx) => query(sql`update ${name} set workspace_id = workspace_id where workspace_id = ${theirs.workspaceId} returning 1`, tx));
      expect(updated, table).toEqual([]);
      const deleted = await withWorkspace(db, mine.workspaceId, (tx) => query(sql`delete from ${name} where workspace_id = ${theirs.workspaceId} returning 1`, tx));
      expect(deleted, table).toEqual([]);
      const [after] = await query(sql`select count(*)::int as count from ${name} where workspace_id = ${theirs.workspaceId}`);
      expect(after.count, `${table} lost rows to another workspace`).toBe(before.count);
    }
  });

  it("won't take a row written into another workspace", async () => {
    await expect(withWorkspace(db, mine.workspaceId, (tx) => tx.execute(sql`insert into site (workspace_id, name) values (${theirs.workspaceId}, 'planted.example')`))).rejects.toThrow();
    await expect(withWorkspace(db, mine.workspaceId, (tx) => tx.execute(sql`update site set workspace_id = ${theirs.workspaceId} where name = 'acme.example'`))).rejects.toThrow();
  });

  it("fills in the workspace of the transaction when a row doesn't say", async () => {
    await withWorkspace(db, mine.workspaceId, (tx) => tx.execute(sql`insert into site (name) values ('filled-in.example')`));
    const [row] = await query(sql`select workspace_id from site where name = 'filled-in.example'`);
    expect(row.workspace_id).toBe(mine.workspaceId);
  });

  it("shows nothing at all with no workspace set, even as the app role", async () => {
    for (const table of tables) {
      const rows = await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('role', 'tenant_app', true)`);
        return query(sql`select 1 from ${sql.identifier(table)}`, tx);
      });
      expect(rows, table).toEqual([]);
    }
  });
});

describe("what stays with the trusted path", () => {
  it("can't be written by the app role: memberships, workspaces and identity", async () => {
    for (const statement of [sql`insert into member (workspace_id, user_id, role) values (${mine.workspaceId}, ${theirs.userId}, 'owner')`, sql`update workspace set name = 'Stolen'`, sql`update "user" set email = 'x@y.example'`]) {
      await expect(withWorkspace(db, mine.workspaceId, (tx) => tx.execute(statement))).rejects.toThrow();
    }
  });

  it("can't be read by the app role when it's identity or an assistant's tokens", async () => {
    for (const table of ["user", "session", "account", "oauth_access_token", "oauth_client", "jwks"]) {
      await expect(withWorkspace(db, mine.workspaceId, (tx) => tx.execute(sql`select 1 from ${sql.identifier(table)}`)), table).rejects.toThrow();
    }
  });

  it("is a list that only names tables that exist, so it can't hide a mistake", async () => {
    const existing = (await query(sql`select tablename from pg_tables where schemaname = 'public'`)).map(({ tablename }) => tablename);
    for (const table of TRUSTED_TABLES) expect(existing, `${table} no longer exists: take it off the list`).toContain(table);
  });
});
