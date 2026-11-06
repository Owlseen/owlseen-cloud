import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/mcp/route";
import { trackedKeywordsOf } from "@/application/rank-tracker";
import type { Services } from "@/application/services";
import { removeMember } from "@/application/team";
import { periodEndingAt } from "@/application/time-range";
import { startWorkspace } from "@/application/workspaces";
import type { Database } from "@/infrastructure/db/client";
import { member } from "@/infrastructure/db/schema/tenancy";
import type { Env } from "@/infrastructure/env";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { EXPECTED_TOOLS, followSite, INITIALIZE, mcpRequest, NOW, teammate, testServices } from "./support/search";

const token = vi.hoisted(() => ({ userId: "" as string | null }));
const shared = vi.hoisted(() => ({ services: undefined as unknown, settings: { BETTER_AUTH_URL: "https://owlseen.test" } }));
vi.mock("server-only", () => ({}));
vi.mock("@/infrastructure/auth/server", () => ({
  memberOfToken: async () => {
    if (!token.userId) throw new Error("No token");
    return { userId: token.userId, clientId: "assistant" };
  },
}));
vi.mock("@/infrastructure/db/client", async (original) => ({ ...(await original<typeof import("@/infrastructure/db/client")>()), db: () => (shared.services as Services).db }));
vi.mock("@/infrastructure/env", async (original) => ({ ...(await original<typeof import("@/infrastructure/env")>()), env: () => shared.settings }));
vi.mock("@/infrastructure/services", () => ({ appServices: () => shared.services }));

const settings = { OWLSEEN_ADMINS: "founder@example.com", BETTER_AUTH_URL: "https://owlseen.test", BETTER_AUTH_SECRET: "a-long-enough-secret-for-signing-tests-only", OWLSEEN_SECRETS_KEY: Buffer.alloc(32, 1).toString("base64") } as Env;

let db: Database;
let services: Services;
beforeAll(async () => {
  db = await createTestDatabase();
  services = { ...testServices(db).services, settings };
  shared.services = services;
});
beforeEach(() => {
  token.userId = null;
});

/** Speaks to /api/mcp over HTTP, as an assistant does: the real route, with only the token's signature assumed. */
async function send(message: unknown) {
  const response = await POST(mcpRequest(message, { authorization: "Bearer token" }));
  const text = await response.text();
  if (text.startsWith("{")) return { status: response.status, body: JSON.parse(text), text };
  const replies = text.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  return { status: response.status, body: Array.isArray(message) ? replies : (replies[0] ?? null), text };
}

const rpc = async (method: string, params: Record<string, unknown> = {}) => (await send({ jsonrpc: "2.0", id: 1, method, params })).body.result;
const tool = (name: string, args: Record<string, unknown> = {}) => rpc("tools/call", { name, arguments: args });
const siteNames = (result: { structuredContent: { sites: { name: string }[] } }) => result.structuredContent.sites.map(({ name }) => name);

/** A member with two workspaces, each with its own site, and a stranger's with its own. */
async function memberOfTwo() {
  const { workspaceId: acme, userId } = await createTestWorkspace(db, "Acme");
  const northwind = (await startWorkspace(db, settings, { userId, email: "founder@example.com" }, "Northwind")) as string;
  const stranger = await createTestWorkspace(db, "Secret Corp");
  const acmeSite = await followSite(db, acme, "acme.example");
  const northwindSite = await followSite(db, northwind, "northwind.example");
  const strangerSite = await followSite(db, stranger.workspaceId, "secret.example");
  token.userId = userId;
  return { acme, northwind, userId, stranger: stranger.workspaceId, acmeSite: acmeSite.id, northwindSite: northwindSite.id, strangerSite: strangerSite.id };
}

const followed = async (workspaceId: string) => (await trackedKeywordsOf(db, workspaceId, null, periodEndingAt(NOW, 1))).map(({ text }) => text);

const refusedWithNames = (result: { isError?: boolean; content: { text: string }[] }) => {
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('"Acme"');
  expect(result.content[0].text).toContain('"Northwind"');
};

describe("an assistant, for a member with several workspaces", () => {
  it("answers the protocol's own methods without asking which workspace", async () => {
    await memberOfTwo();
    const started = await rpc("initialize", INITIALIZE);
    expect(started.serverInfo.name).toBe("owlseen");
    expect(started.instructions).toContain("confirm with the member which workspace");
    expect((await send({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    expect(await rpc("ping")).toEqual({});
  });

  it("offers an optional workspace argument on every tool but list_workspaces, saying what it's for", async () => {
    await memberOfTwo();
    const { tools } = await rpc("tools/list");
    for (const { name, inputSchema } of tools) {
      if (name === "list_workspaces") {
        expect(inputSchema.properties ?? {}).not.toHaveProperty("workspace");
        continue;
      }
      expect(inputSchema.properties.workspace, name).toMatchObject({ type: "string", description: expect.stringContaining("exact name") });
      expect(inputSchema.required ?? []).not.toContain("workspace");
    }
  });

  it("lists their workspaces with their role, read-only", async () => {
    const { acme, northwind } = await memberOfTwo();
    const { tools } = await rpc("tools/list");
    expect(tools.find(({ name }: { name: string }) => name === "list_workspaces").annotations.readOnlyHint).toBe(true);
    const { structuredContent } = await tool("list_workspaces");
    expect(structuredContent.workspaces).toEqual([
      { id: acme, name: "Acme", role: "owner" },
      { id: northwind, name: "Northwind", role: "owner" },
    ]);
  });

  it("refuses a call that names no workspace, listing theirs so the assistant asks", async () => {
    await memberOfTwo();
    refusedWithNames(await tool("sites_followed"));
  });

  it("works in the workspace named, by name or by id, and sees only that one's sites", async () => {
    const { acme, northwind } = await memberOfTwo();
    expect(siteNames(await tool("sites_followed", { workspace: "Acme" }))).toEqual(["acme.example"]);
    expect(siteNames(await tool("sites_followed", { workspace: "Northwind" }))).toEqual(["northwind.example"]);
    expect(siteNames(await tool("sites_followed", { workspace: acme }))).toEqual(["acme.example"]);
    expect(siteNames(await tool("sites_followed", { workspace: northwind }))).toEqual(["northwind.example"]);
  });

  it("writes in the workspace named, and nowhere else", async () => {
    const { acme, northwind, northwindSite } = await memberOfTwo();
    expect((await tool("track_keyword", { workspace: "Northwind", site: northwindSite, keyword: "northwind pricing" })).isError).toBeUndefined();
    expect(await followed(northwind)).toEqual(["northwind pricing"]);
    expect(await followed(acme)).toEqual([]);
  });

  it("doesn't find a site of one workspace when the call names the other, both being theirs", async () => {
    const { acme, northwindSite } = await memberOfTwo();
    const refused = await tool("track_keyword", { workspace: "Acme", site: northwindSite, keyword: "wrong company" });
    expect(refused.isError).toBe(true);
    expect((await tool("site_overview", { workspace: "Acme", site: northwindSite })).isError).toBe(true);
    expect(await followed(acme)).toEqual([]);
  });

  it("gives the same refusal for a workspace that doesn't exist and one that isn't theirs, by name or id", async () => {
    const { stranger } = await memberOfTwo();
    const without = await tool("sites_followed");
    for (const named of ["Secret Corp", stranger, "Nobody's", "acme", "33333333-3333-4333-8333-333333333333"]) {
      const refused = await tool("sites_followed", { workspace: named });
      expect(refused).toEqual(without);
      expect(JSON.stringify(refused)).not.toContain("Secret");
    }
  });

  it("can't write into a workspace that isn't theirs", async () => {
    const { stranger, strangerSite } = await memberOfTwo();
    refusedWithNames(await tool("track_keyword", { workspace: stranger, site: strangerSite, keyword: "planted" }));
    expect(await followed(stranger)).toEqual([]);
  });

  it("serves each call of a batch in its own workspace", async () => {
    await memberOfTwo();
    const call = (id: number, workspace?: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "sites_followed", arguments: workspace ? { workspace } : {} } });
    const { body } = await send([call(1, "Acme"), call(2, "Northwind"), call(3)]);
    const byId = Object.fromEntries(body.map((reply: { id: number; result: unknown }) => [reply.id, reply.result]));
    expect(siteNames(byId[1] as never)).toEqual(["acme.example"]);
    expect(siteNames(byId[2] as never)).toEqual(["northwind.example"]);
    refusedWithNames(byId[3]);
  });

  it("still validates a tool's own arguments", async () => {
    await memberOfTwo();
    const refused = await tool("track_keyword", { workspace: "Acme" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("Invalid arguments");
  });

  it("offers nothing that invites, removes or changes members", async () => {
    await memberOfTwo();
    const { tools } = await rpc("tools/list");
    for (const { name } of tools) expect(name).not.toMatch(/invit|member|team|role/i);
    expect(tools.map(({ name }: { name: string }) => name).filter((name: string) => /workspace/.test(name))).toEqual(["list_workspaces"]);
  });

  it("forgets a workspace at once when they're taken out of it, even on the same token", async () => {
    const { acme, northwind, userId } = await memberOfTwo();
    expect(siteNames(await tool("sites_followed", { workspace: "Northwind" }))).toEqual(["northwind.example"]);
    await db.delete(member).where(and(eq(member.workspaceId, northwind), eq(member.userId, userId)));
    const refused = await tool("sites_followed", { workspace: "Northwind" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('"Acme"');
    expect(refused.content[0].text).not.toContain("Northwind");
    expect((await tool("list_workspaces")).structuredContent.workspaces).toEqual([{ id: acme, name: "Acme", role: "owner" }]);
  });
});

describe("an assistant, for a member with one workspace", () => {
  async function memberOfOne() {
    const { workspaceId, userId } = await createTestWorkspace(db, "Solo");
    const site = await followSite(db, workspaceId, "solo.example");
    token.userId = userId;
    return { workspaceId, userId, siteId: site.id };
  }

  it("sees no workspace argument anywhere, and no word about several", async () => {
    await memberOfOne();
    const { tools } = await rpc("tools/list");
    expect(tools).toHaveLength(EXPECTED_TOOLS.length);
    for (const { name, inputSchema } of tools) expect(inputSchema.properties ?? {}, name).not.toHaveProperty("workspace");
    expect(JSON.stringify(tools)).not.toContain("exact name");
    const started = await rpc("initialize", INITIALIZE);
    expect(started.instructions).not.toContain("several companies");
  });

  it("works with no argument to give", async () => {
    const { workspaceId, siteId } = await memberOfOne();
    expect(siteNames(await tool("sites_followed"))).toEqual(["solo.example"]);
    await tool("track_keyword", { site: siteId, keyword: "solo pricing" });
    expect(await followed(workspaceId)).toEqual(["solo pricing"]);
  });

  it("still lists their workspace", async () => {
    const { workspaceId } = await memberOfOne();
    expect((await tool("list_workspaces")).structuredContent.workspaces).toEqual([{ id: workspaceId, name: "Solo", role: "owner" }]);
  });

  it("accepts its own workspace named, but refuses another rather than quietly using theirs", async () => {
    const { workspaceId, siteId } = await memberOfOne();
    expect(siteNames(await tool("sites_followed", { workspace: "Solo" }))).toEqual(["solo.example"]);
    expect(siteNames(await tool("sites_followed", { workspace: workspaceId }))).toEqual(["solo.example"]);
    const refused = await tool("track_keyword", { workspace: "The one they left", site: siteId, keyword: "wrong company" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('"Solo"');
    expect(await followed(workspaceId)).toEqual([]);
  });
});

describe("/api/mcp at its door", () => {
  it("answers 401 without a token, pointing at how to sign in", async () => {
    const { status, body } = await send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(status).toBe(401);
    expect(body.error).toBe("unauthorized");
  });

  it("keeps its 403 for someone with no workspace, even for list_workspaces", async () => {
    const { workspaceId, userId: owner } = await createTestWorkspace(db, "Left behind");
    const id = await teammate(db, workspaceId);
    await removeMember(db, workspaceId, owner, id);
    token.userId = id;
    const { status, body } = await send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_workspaces", arguments: {} } });
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: "no_workspace", error_description: expect.stringContaining("https://owlseen.test/welcome") });
  });

  it("gives that 403 to someone removed from their only workspace, on their next call", async () => {
    const { workspaceId, userId: ownerId } = await createTestWorkspace(db, "Team");
    const id = await teammate(db, workspaceId);
    token.userId = id;
    expect((await tool("sites_followed")).structuredContent.sites).toEqual([]);
    await removeMember(db, workspaceId, ownerId, id);
    expect((await send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "sites_followed", arguments: {} } })).status).toBe(403);
  });

});
