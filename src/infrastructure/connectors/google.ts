import type { Check, EngineDay, EngineSitemap, Inspection, NamedDay, NamedSlice, SearchProperty } from "@/application/ports";
import { dayAfter, dayBetween, daysBefore } from "@/domain/days";
import type { Adapter, AdapterClient, AdapterContext } from "./adapter";
import { checked } from "./checked";
import { bearerJson, ProviderError, requestJson, withRetries } from "./http";

const NAME = "Google";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CONSENT_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const USER_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const API = "https://www.googleapis.com/webmasters/v3";
const INSPECT_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";
/** Reading figures, and submitting sitemaps: Search Console's scope has no narrower one that does both. */
const SCOPES = "https://www.googleapis.com/auth/webmasters openid email";
/** The most Search Analytics answers in one request. */
const ROWS_A_PAGE = 25_000;
/** How many pages a stretch of days is read to, before it's read in two shorter ones. */
const MOST_PAGES = 4;
const MOST_ROWS_READ = ROWS_A_PAGE * MOST_PAGES;
/** Keywords and pages are read this many days at a time: a daily read is one slice, a first read seven. */
const DAYS_A_SLICE = 14;
const NOT_A_REAL_TOKEN = "owlseen-connection-check";

interface AnalyticsRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  position?: number;
}

/** A domain property's or a URL property's domain, without www. */
export function domainOf(property: string): string {
  const bare = property.startsWith("sc-domain:") ? property.slice("sc-domain:".length) : property;
  try {
    return new URL(bare.includes("://") ? bare : `https://${bare}`).hostname.replace(/^www\./, "");
  } catch {
    return bare.replace(/^www\./, "");
  }
}

interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
}

const tokenRequest = (context: Pick<AdapterContext, "fetch" | "fields">, grant: Record<string, string>) =>
  requestJson<TokenAnswer>(context.fetch, NAME, TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: context.fields.clientId, client_secret: context.fields.clientSecret, ...grant }).toString(),
  });

/** The address a member is sent to, to allow access. `offline` and `consent` are what get a refresh token back every time. */
export function consentAddress(clientId: string, redirectUri: string, state: string): string {
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: SCOPES, access_type: "offline", prompt: "consent", state });
  return `${CONSENT_URL}?${query}`;
}

/** Turns what Google sent back into the refresh token that lasts, and whose account it is. */
export async function exchangeConsentCode(context: Pick<AdapterContext, "fetch" | "fields">, code: string, redirectUri: string): Promise<{ refreshToken: string; account: string | null }> {
  const answer = await tokenRequest(context, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
  if (!answer.refresh_token) throw new ProviderError(NAME, 400, "Google didn’t give a lasting token. Remove this app’s access in your Google account, and allow it again.");
  const user = await requestJson<{ email?: string }>(context.fetch, NAME, USER_URL, { headers: bearerJson(answer.access_token ?? "") }).catch(() => ({ email: undefined }));
  return { refreshToken: answer.refresh_token, account: user.email ?? null };
}

/**
 * Tries the client at Google's token endpoint with a token that can't exist, so nothing happens for
 * anyone. A good client gets invalid_grant, which is about the token; anything else is about the client.
 */
async function checkClient(context: AdapterContext): Promise<Check> {
  try {
    await tokenRequest(context, { grant_type: "refresh_token", refresh_token: NOT_A_REAL_TOKEN });
  } catch (error) {
    if (error instanceof ProviderError && /invalid_grant|bad request/i.test(error.message)) return { ok: true, detail: "Google accepted this client. Now allow access with your account." };
    if (error instanceof ProviderError && error.status >= 500) throw error;
    return { ok: false, detail: "Google refused this client. Check its ID and secret." };
  }
  return { ok: true, detail: "Google accepted this client. Now allow access with your account." };
}

/** Google says a lasting token has ended with a 400 (invalid_grant): to whoever reads this, it's refused credentials. */
const endedTokenAsRefused = (error: unknown): never => {
  throw error instanceof ProviderError && error.status === 400 ? new ProviderError(NAME, 401, error.message) : error;
};

function apiOf(context: AdapterContext) {
  let accessToken: Promise<string> | undefined;
  const askForToken = () =>
    tokenRequest(context, { grant_type: "refresh_token", refresh_token: context.fields.refreshToken })
      .catch(endedTokenAsRefused)
      .then((answer) => {
        if (!answer.access_token) throw new ProviderError(NAME, 401, "Google gave no access token: allow access again.");
        return answer.access_token;
      });
  const token = () =>
    (accessToken ??= askForToken().catch((error) => {
      // A failure isn't kept: the next try asks Google again rather than repeat it.
      accessToken = undefined;
      throw error;
    }));
  return async <T>(url: string, init: RequestInit = {}) => withRetries(context.wait, async () => requestJson<T>(context.fetch, NAME, url, { ...init, headers: bearerJson(await token()) }));
}

type Api = ReturnType<typeof apiOf>;

const propertyPath = (property: string) => `${API}/sites/${encodeURIComponent(property)}`;

async function propertiesOf(api: Api): Promise<SearchProperty[]> {
  const { siteEntry = [] } = await api<{ siteEntry?: { siteUrl: string; permissionLevel?: string }[] }>(`${API}/sites`);
  return siteEntry.filter(({ permissionLevel }) => permissionLevel !== "siteUnverifiedUser").map(({ siteUrl }) => ({ id: siteUrl, domain: domainOf(siteUrl) }));
}

/**
 * Rows of one query, every page of them: an answer as long as a page may have more behind it. No
 * dataState: left to its default Google answers only with days it has finished, and a day still
 * coming in would read as a fall. Its days run on Pacific time, whatever the time here.
 */
async function pagesOfRows(api: Api, property: string, dimensions: string[], from: string, to: string): Promise<AnalyticsRow[]> {
  const rows: AnalyticsRow[] = [];
  for (let page = 0; page < MOST_PAGES; page += 1) {
    const body = JSON.stringify({ startDate: from, endDate: to, dimensions, rowLimit: ROWS_A_PAGE, startRow: page * ROWS_A_PAGE });
    const { rows: found = [] } = await api<{ rows?: AnalyticsRow[] }>(`${propertyPath(property)}/searchAnalytics/query`, { method: "POST", body });
    rows.push(...found);
    if (found.length < ROWS_A_PAGE) break;
  }
  return rows;
}

/** Failing like this, a shorter stretch may well work: it timed out, or Google couldn't put it together. */
const worthAShorterStretch = (error: unknown) => error instanceof ProviderError && (error.status === 0 || error.status >= 500);

/**
 * All of a stretch of days, oldest first, as it's read. Rows come oldest first, so what's cut off when
 * there are too many is the newest: a stretch that fills every page, or fails, is read again in two
 * halves, down to a single day, which is all Google will give of that day.
 */
async function* stretchOfRows(api: Api, property: string, dimensions: string[], from: string, to: string): AsyncGenerator<{ rows: AnalyticsRow[]; through: string }> {
  const rows = await pagesOfRows(api, property, dimensions, from, to).catch((error: unknown) => {
    if (from === to || !worthAShorterStretch(error)) throw error;
    return null;
  });
  if (rows && (rows.length < MOST_ROWS_READ || from === to)) {
    yield { rows, through: to };
    return;
  }
  const middle = dayBetween(from, to);
  yield* stretchOfRows(api, property, dimensions, from, middle);
  yield* stretchOfRows(api, property, dimensions, dayAfter(middle), to);
}

/** A long stretch, in short ones: each is saved as it comes, so a read stopped halfway has lost little and carries on. */
async function* slicesOfRows(api: Api, property: string, dimensions: string[], from: string, to: string): AsyncGenerator<{ rows: AnalyticsRow[]; through: string }> {
  for (let start = from; start <= to; start = dayAfter(daysBefore(start, -(DAYS_A_SLICE - 1)))) {
    const end = daysBefore(start, -(DAYS_A_SLICE - 1));
    yield* stretchOfRows(api, property, dimensions, start, end < to ? end : to);
  }
}

async function* namedSlices(api: Api, property: string, dimensions: string[], from: string, to: string): AsyncGenerator<NamedSlice> {
  for await (const { rows, through } of slicesOfRows(api, property, dimensions, from, to)) yield { days: namedDaysOf(rows), through };
}

async function analyticsRows(api: Api, property: string, dimensions: string[], from: string, to: string): Promise<AnalyticsRow[]> {
  const all: AnalyticsRow[] = [];
  for await (const { rows } of stretchOfRows(api, property, dimensions, from, to)) all.push(...rows);
  return all;
}

const daysOf = (rows: AnalyticsRow[]): EngineDay[] => rows.flatMap(({ keys, clicks = 0, impressions = 0, position }) => (keys?.[0] ? [{ day: keys[0], clicks, impressions, position: position ?? null }] : []));

const namedDaysOf = (rows: AnalyticsRow[]): NamedDay[] => rows.flatMap(({ keys, clicks = 0, impressions = 0, position = 0 }) => (keys?.[0] && keys[1] ? [{ name: keys[0], day: keys[1], clicks, impressions, position }] : []));

interface SitemapEntry {
  path: string;
  lastSubmitted?: string;
  lastDownloaded?: string;
  errors?: string | number;
  warnings?: string | number;
  contents?: { submitted?: string | number }[];
}

const dateOr = (value: string | undefined) => (value ? new Date(value) : null);

const sitemapOf = ({ path, lastSubmitted, lastDownloaded, errors, warnings, contents = [] }: SitemapEntry): EngineSitemap => ({
  url: path,
  submittedAt: dateOr(lastSubmitted),
  lastReadAt: dateOr(lastDownloaded),
  errors: Number(errors ?? 0),
  warnings: Number(warnings ?? 0),
  urls: contents.reduce((total, { submitted }) => total + Number(submitted ?? 0), 0),
});

export function inspectionOf(answer: unknown): Inspection {
  const status = (answer as { inspectionResult?: { indexStatusResult?: { verdict?: string; coverageState?: string; lastCrawlTime?: string } } })?.inspectionResult?.indexStatusResult;
  const crawled = status?.lastCrawlTime ? new Date(status.lastCrawlTime) : null;
  return { verdict: status?.verdict ?? "VERDICT_UNSPECIFIED", coverage: status?.coverageState ?? null, lastCrawlAt: crawled && !Number.isNaN(crawled.getTime()) ? crawled : null };
}

export const googleAdapter: Adapter = (context): AdapterClient => {
  const api = apiOf(context);
  return {
    engine: "google",
    check: () =>
      checked(NAME, async () => {
        if (!context.fields.refreshToken) return checkClient(context);
        const properties = await propertiesOf(api);
        return { ok: true, detail: `Google answers: ${properties.length} properties.`, label: context.fields.account };
      }),
    properties: () => propertiesOf(api),
    days: async (property, from, to) => daysOf(await analyticsRows(api, property, ["date"], from, to)),
    keywordSlices: (property, from, to) => namedSlices(api, property, ["query", "date"], from, to),
    pageSlices: (property, from, to) => namedSlices(api, property, ["page", "date"], from, to),
    inspect: async (property, url) => inspectionOf(await api(INSPECT_URL, { method: "POST", body: JSON.stringify({ siteUrl: property, inspectionUrl: url, languageCode: "en-US" }) })),
    sitemaps: async (property) => ((await api<{ sitemap?: SitemapEntry[] }>(`${propertyPath(property)}/sitemaps`)).sitemap ?? []).map(sitemapOf),
    submitSitemap: async (property, url) => void (await api(`${propertyPath(property)}/sitemaps/${encodeURIComponent(url)}`, { method: "PUT" })),
  };
};
