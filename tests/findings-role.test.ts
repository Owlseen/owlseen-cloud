import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vitest";
import { createWorkspace, workspacesOf } from "@/application/workspaces";
import { DRIZZLE_CASING, schema, type Database } from "@/infrastructure/db/client";
import { user } from "@/infrastructure/db/schema/auth";
import { site } from "@/infrastructure/db/schema/search";
import { withWorkspace } from "@/infrastructure/db/tenant";

/**
 * The repo's tests run as PGlite's superuser. Production connects as a non-superuser that owns the
 * tables and has BYPASSRLS, so this runs the migration and the scope as such a role.
 */
const FOLDER = "src/infrastructure/db/migrations";
let client: PGlite;
let db: Database;

const rows = async (statement: ReturnType<typeof sql>, on: Database = db) => ((await on.execute(statement)) as unknown as { rows: Record<string, unknown>[] }).rows;

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`CREATE ROLE app_owner LOGIN BYPASSRLS CREATEROLE NOSUPERUSER; GRANT ALL ON DATABASE postgres TO app_owner; GRANT ALL ON SCHEMA public TO app_owner; SET ROLE app_owner;`);
  db = drizzle(client, { schema, casing: DRIZZLE_CASING }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: FOLDER });
}, 400_000);

describe("as a BYPASSRLS owner that isn't a superuser", () => {
  it("really is that role", async () => {
    const [me] = await rows(sql`select current_user as name, r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user`);
    expect(me).toEqual({ name: "app_owner", rolsuper: false, rolbypassrls: true });
  });

  it("the migration applies from scratch, and again as a no-op", async () => {
    await migrate(db as never, { migrationsFolder: FOLDER });
    const [{ count }] = await rows(sql`select count(*)::int as count from drizzle.__drizzle_migrations`);
    expect(count).toBe(1);
  });

  it("the owner owns the tables and sees across workspaces: the trusted path", async () => {
    const [{ owner }] = await rows(sql`select tableowner as owner from pg_tables where tablename = 'site'`);
    expect(owner).toBe("app_owner");
  });

  it("inside the scope, the role is tenant_app and row-level security applies", async () => {
    const ids: string[] = [];
    for (const name of ["Mine", "Theirs"]) {
      const userId = crypto.randomUUID();
      await db.insert(user).values({ id: userId, name, email: `${userId}@example.test` });
      const workspaceId = await createWorkspace(db, userId, name);
      await withWorkspace(db, workspaceId, (tx) => tx.insert(site).values({ name: `${name}.example` }));
      ids.push(workspaceId);
    }
    const inScope = await withWorkspace(db, ids[0], async (tx) => {
      const [me] = await rows(sql`select current_user as name`, tx);
      return { me, seen: await tx.select({ name: site.name }).from(site) };
    });
    expect(inScope.me).toEqual({ name: "tenant_app" });
    expect(inScope.seen).toEqual([{ name: "Mine.example" }]);
    expect((await db.select({ name: site.name }).from(site)).length).toBeGreaterThanOrEqual(2);
  });

  it("the role doesn't outlive its transaction", async () => {
    await withWorkspace(db, (await db.select({ id: site.workspaceId }).from(site))[0].id, (tx) => tx.select().from(site));
    const [me] = await rows(sql`select current_user as name, current_setting('app.workspace_id', true) as workspace`);
    expect(me.name).toBe("app_owner");
    expect(me.workspace || null).toBeNull();
  });

  it("a failed scope doesn't leave the role behind", async () => {
    await withWorkspace(db, (await db.select({ id: site.workspaceId }).from(site))[0].id, async (tx) => {
      await tx.execute(sql`select 1/0`);
    }).catch(() => {});
    const [me] = await rows(sql`select current_user as name`);
    expect(me.name).toBe("app_owner");
  });

  it("tenant_app can't reach identity tables", async () => {
    const id = (await db.select({ id: site.workspaceId }).from(site))[0].id;
    await expect(withWorkspace(db, id, (tx) => tx.execute(sql`select 1 from "user"`))).rejects.toThrow();
  });

  it("a workspace id that isn't the member's reads nothing of value on trusted path helpers", async () => {
    expect(await workspacesOf(db, "nobody")).toEqual([]);
  });
});

describe("a tenant_app role made by someone else on the same cluster", () => {
  it("stops the migration, as docs/00-product.md says: its grant can't be taken from another owner", async () => {
    const other = new PGlite();
    await other.exec(`CREATE ROLE tenant_app NOLOGIN NOBYPASSRLS; CREATE ROLE second_owner LOGIN BYPASSRLS CREATEROLE NOSUPERUSER; GRANT ALL ON DATABASE postgres TO second_owner; GRANT ALL ON SCHEMA public TO second_owner; SET ROLE second_owner;`);
    const database = drizzle(other, { schema, casing: DRIZZLE_CASING }) as unknown as Database;
    await expect(migrate(database as never, { migrationsFolder: FOLDER })).rejects.toThrow();
  });
});
