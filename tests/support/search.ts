import { createMcpHandler } from "@modelcontextprotocol/server";
import { searchServer } from "@/app/api/mcp/server";
import { connectWithFields } from "@/application/connections";
import { finishGoogleConsent, startGoogleConsent } from "@/application/google-consent";
import type { Services } from "@/application/services";
import { workspacesOf } from "@/application/workspaces";
import type { Engine } from "@/domain/search";
import type { Database } from "@/infrastructure/db/client";
import { user } from "@/infrastructure/db/schema/auth";
import { keyword, keywordDay, page, pageDay, searchDay, site } from "@/infrastructure/db/schema/search";
import { member } from "@/infrastructure/db/schema/tenancy";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Env } from "@/infrastructure/env";
import { fakeFetch, type FakeRoute } from "./fetch";

export const NOW = new Date("2026-11-05T09:00:00Z");
export const NEXT_DAY = new Date("2026-11-06T09:00:00Z");
export const SECRETS_KEY = Buffer.alloc(32, 1).toString("base64");
export const AUTH_SECRET = "a-long-enough-secret-for-signing-tests-only";

export const testSettings = { BETTER_AUTH_URL: "https://owlseen.test", BETTER_AUTH_SECRET: AUTH_SECRET, OWLSEEN_SECRETS_KEY: SECRETS_KEY, OWLSEEN_ADMINS: "", OWLSEEN_DATABASE_URL: "postgres://unused", OWLSEEN_MAIL_FROM: "Owlseen <no-reply@example.com>", OWLSEEN_PASSWORD_SIGN_IN: false, OIDC_NAME: "SSO" } as Env;

// ─── What the engines answer ───────────────────────────────────────────────

const SEARCH_CONSOLE = "https://www.googleapis.com/webmasters/v3/sites";
const BING_API = "https://ssl.bing.com/webmaster/api.svc/json";

export const googleSites = (...siteUrls: string[]): FakeRoute => ({ match: `GET ${SEARCH_CONSOLE}`, json: { siteEntry: siteUrls.map((siteUrl) => ({ siteUrl, permissionLevel: "siteOwner" })) } });
export const bingSites = (...urls: string[]): FakeRoute => ({ match: `GET ${BING_API}/GetUserSites`, json: { d: urls.map((Url) => ({ Url })) } });

/** Google, answering as a healthy account does: one domain property with figures. */
export const GOOGLE_TOKEN: FakeRoute = { match: "POST https://oauth2.googleapis.com/token", json: { access_token: "an-access-token", refresh_token: "a-refresh-token" } };
export const GOOGLE_USER: FakeRoute = { match: "GET https://openidconnect.googleapis.com/v1/userinfo", json: { email: "ada@acme.example" } };
export const GOOGLE_SITES = googleSites("sc-domain:acme.example");
export const BING_SITES = bingSites("https://www.acme.example/");

export const HEALTHY_ACCOUNTS: FakeRoute[] = [GOOGLE_TOKEN, GOOGLE_USER, GOOGLE_SITES, BING_SITES];

export interface AnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  position?: number;
}

export interface GoogleAnswers {
  totals?: AnalyticsRow[];
  keywords?: AnalyticsRow[];
  pages?: AnalyticsRow[];
  sitemaps?: unknown[];
}

const propertyAddress = (property: string) => `${SEARCH_CONSOLE}/${encodeURIComponent(property)}`;

/** Search Console's address for a property's sitemap, as a submission reaches it. */
export const googleSitemapAddress = (property: string, url: string) => `${propertyAddress(property)}/sitemaps/${encodeURIComponent(url)}`;

/** Search Console answering about one property, per kind of question. These go before `GOOGLE_SITES`, whose address starts the same. */
export function googleProperty(property: string, answers: GoogleAnswers = {}): FakeRoute[] {
  const query = (dimensions: string[], rows: AnalyticsRow[] = []): FakeRoute => ({ match: `POST ${propertyAddress(property)}/searchAnalytics/query`, bodyHas: `"dimensions":${JSON.stringify(dimensions)}`, json: { rows } });
  return [query(["date"], answers.totals), query(["query", "date"], answers.keywords), query(["page", "date"], answers.pages), { match: `GET ${propertyAddress(property)}/sitemaps`, json: { sitemap: answers.sitemaps ?? [] } }];
}

/** Search Console failing every question about one property. */
export function googlePropertyFailing(property: string, status: number, message: string): FakeRoute[] {
  return [`POST ${propertyAddress(property)}/searchAnalytics/query`, `GET ${propertyAddress(property)}/sitemaps`].map((match) => ({ match, status, json: { error: { message } } }));
}

export interface BingDay {
  Date: string;
  Clicks: number;
  Impressions: number;
}

export const bingFigures = (days: BingDay[] = [], feeds: unknown[] = []): FakeRoute[] => [
  { match: `GET ${BING_API}/GetRankAndTrafficStats`, json: { d: days } },
  { match: `GET ${BING_API}/GetFeeds`, json: { d: feeds } },
];

/** Google's answer about a page's index status. */
export const inspected = (verdict: string, coverageState: string | null = null, lastCrawlTime?: string) => ({ inspectionResult: { indexStatusResult: { verdict, coverageState, lastCrawlTime } } });
export const INSPECT = "POST https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

// ─── Services ──────────────────────────────────────────────────────────────

/** Services for a test: a clock that holds still, a network that answers from canned routes, and waiting that doesn't. */
export function testServices(db: Database, routes: FakeRoute[] = HEALTHY_ACCOUNTS, now = NOW) {
  const network = fakeFetch(routes);
  const services: Services = { db, settings: testSettings, fetch: network.fetch, now: () => now, wait: async () => {} };
  return { services, calls: network.calls };
}

/** Services whose time runs out the moment the network first answers: a job with a deadline stops at its next turn. */
export function servicesRunningOutOfTime(db: Database, routes: FakeRoute[], deadline: number) {
  const { services, calls } = testServices(db, routes);
  let now = NOW;
  const ageing = (async (...request: Parameters<typeof fetch>) => {
    const answer = await services.fetch(...request);
    now = new Date(deadline);
    return answer;
  }) as typeof fetch;
  return { services: { ...services, fetch: ageing, now: () => now }, calls };
}

// ─── Connections, sites and members ────────────────────────────────────────

/** The state a consent address carries, as Google gives it back. */
export const stateIn = (address: string) => new URL(address).searchParams.get("state") as string;

/** A Google connection, with its client saved and access allowed, as a member leaves it. */
export async function connectGoogle(services: Services, workspaceId: string, userId: string) {
  const made = await connectWithFields(services, workspaceId, userId, "google", { clientId: "a-client.apps.googleusercontent.com", clientSecret: "a-client-secret" });
  if (!made.ok) throw new Error(made.error);
  const started = await startGoogleConsent(services, workspaceId, userId, made.connection.id);
  if ("error" in started) throw new Error(started.error);
  const finished = await finishGoogleConsent(services, stateIn(started.address), "a-code", userId);
  if (!finished.ok) throw new Error(finished.error);
  return made.connection;
}

export async function connectBing(services: Services, workspaceId: string, userId: string) {
  const made = await connectWithFields(services, workspaceId, userId, "bing", { apiKey: "a-bing-key" });
  if (!made.ok) throw new Error(made.error);
  return made.connection;
}

/** A site followed, as adding it would leave it. */
export async function followSite(db: Database, workspaceId: string, name = "acme.example", properties: { googleProperty?: string | null; bingSite?: string | null } = {}) {
  const [row] = await withWorkspace(db, workspaceId, (tx) =>
    tx
      .insert(site)
      .values({ name, googleProperty: properties.googleProperty === undefined ? `sc-domain:${name}` : properties.googleProperty, bingSite: properties.bingSite === undefined ? null : properties.bingSite })
      .returning(),
  );
  return row;
}

/** Someone joining a workspace in this role, and their id. */
export async function teammate(db: Database, workspaceId: string, role: "owner" | "admin" | "member" = "member", name = "Bea") {
  const id = crypto.randomUUID();
  await db.insert(user).values({ id, name, email: `${id}@example.test` });
  await db.insert(member).values({ workspaceId, userId: id, role });
  return id;
}

// ─── Stored figures ────────────────────────────────────────────────────────

export interface StoredDay {
  day: string;
  clicks: number;
  impressions: number;
  position: number;
}

/** A site's totals for some days, on one engine, as a read would leave them. */
export const storeTotals = (db: Database, workspaceId: string, siteId: string, engine: Engine, days: (Omit<StoredDay, "position"> & { position: number | null })[]) =>
  withWorkspace(db, workspaceId, (tx) => tx.insert(searchDay).values(days.map((day) => ({ siteId, engine, ...day }))));

/** A keyword and its days, as a read would leave them; its id. */
export async function storeKeyword(db: Database, workspaceId: string, siteId: string, text: string, days: StoredDay[] = []): Promise<number> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [row] = await tx.insert(keyword).values({ siteId, text }).returning({ id: keyword.id });
    if (days.length > 0) await tx.insert(keywordDay).values(days.map((day) => ({ siteId, keywordId: row.id, ...day })));
    return row.id;
  });
}

/** A page and its days, as a read would leave them; its id. */
export async function storePage(db: Database, workspaceId: string, siteId: string, url: string, days: StoredDay[] = []): Promise<number> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [row] = await tx.insert(page).values({ siteId, url }).returning({ id: page.id });
    if (days.length > 0) await tx.insert(pageDay).values(days.map((day) => ({ siteId, pageId: row.id, ...day })));
    return row.id;
  });
}

// ─── The assistant's side ──────────────────────────────────────────────────

/** Every tool an assistant is offered, in alphabetical order. */
export const EXPECTED_TOOLS = ["alerts", "create_api_key", "index_status", "inspect_url", "keywords_that_moved", "list_api_keys", "list_groups", "list_sites", "list_workspaces", "opportunities", "pages_losing_clicks", "remove_group", "revoke_api_key", "save_group", "site_overview", "sites_followed", "submit_sitemap", "top_keywords", "top_pages", "track_keyword", "tracked_keywords", "untrack_keyword"];

export const INITIALIZE = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } };

/** The one reply a streamable HTTP answer carries, whichever way it was framed. */
export function replyIn(text: string) {
  const json = text.startsWith("{") ? text : (text.split("\n").find((line) => line.startsWith("data: ")) ?? "").slice(6);
  return JSON.parse(json);
}

export const mcpRequest = (message: unknown, headers: Record<string, string> = {}) =>
  new Request("https://owlseen.test/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...headers },
    body: JSON.stringify(message),
  });

/** Speaks to the MCP server over HTTP, as an assistant does: one JSON-RPC exchange per request, the member's workspaces read now, as the route does. */
export async function rpc(services: Services, userId: string, method: string, params: Record<string, unknown> = {}) {
  const workspaces = await workspacesOf(services.db, userId);
  const handler = createMcpHandler(() => searchServer({ services, userId, workspaces }));
  const response = await handler.fetch(mcpRequest({ jsonrpc: "2.0", id: 1, method, params }));
  return replyIn(await response.text()).result;
}

export const callTool = (services: Services, userId: string, name: string, args: Record<string, unknown> = {}) => rpc(services, userId, "tools/call", { name, arguments: args });
