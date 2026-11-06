import type { EngineDay, EngineSitemap, SearchProperty } from "@/application/ports";
import type { Adapter, AdapterClient, AdapterContext } from "./adapter";
import { checked } from "./checked";
import { ProviderError, requestJson, withRetries } from "./http";
import { domainOf } from "./google";

const NAME = "Bing";
const API = "https://ssl.bing.com/webmaster/api.svc/json";

/** "/Date(1609459200000)/" as a moment; Bing writes every date this way. */
export function bingMoment(value: string | undefined): Date | null {
  const millis = /\/Date\((\d+)/.exec(value ?? "")?.[1];
  return millis ? new Date(Number(millis)) : null;
}

const KEY_REFUSED = "Bing refused this key. Check it in Bing Webmaster Tools, under Settings, API Access.";
const SITE_REFUSED = "Bing refused this key access to this site.";

/** Bing's key travels in the address, so whatever repeats the address repeats the key: it's taken out of anything said about a call. */
const withoutKey = (message: string, key: string) => [key, encodeURIComponent(key)].filter(Boolean).reduce((said, form) => said.replaceAll(form, "…"), message).replace(/apikey=[^&\s"']+/gi, "apikey=…");

/**
 * Bing answers nearly all it refuses with a 400 and names the reason in its message, as in
 * `{"ErrorCode":3,"Message":"ERROR!!! InvalidApiKey"}`. To whoever reads this, an unknown key is refused
 * credentials and a site out of its reach is refused access.
 */
const failureOf = (key: string) => (error: unknown): never => {
  if (!(error instanceof ProviderError)) throw error;
  if (error.status === 400 && /InvalidApiKey/.test(error.message)) throw new ProviderError(NAME, 401, KEY_REFUSED);
  if (error.status === 400 && /NotAuthorized|NotAllowed/.test(error.message)) throw new ProviderError(NAME, 403, SITE_REFUSED);
  throw new ProviderError(NAME, error.status, withoutKey(error.message, key), error.retryAfterMs);
};

function apiOf(context: AdapterContext) {
  const key = context.fields.apiKey;
  const failed = failureOf(key);
  const address = (method: string, query: Record<string, string> = {}) => `${API}/${method}?${new URLSearchParams({ apikey: key, ...query })}`;
  return {
    /** Bing wraps every answer in `d`. */
    get: async <T>(method: string, query?: Record<string, string>) => withRetries(context.wait, async () => (await requestJson<{ d?: T }>(context.fetch, NAME, address(method, query)).catch(failed)).d),
    post: (method: string, body: Record<string, string>) => withRetries(context.wait, () => requestJson(context.fetch, NAME, address(method), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(failed)),
  };
}

type Api = ReturnType<typeof apiOf>;

async function propertiesOf(api: Api): Promise<SearchProperty[]> {
  const sites = (await api.get<{ Url?: string }[]>("GetUserSites")) ?? [];
  return sites.flatMap(({ Url }) => (Url ? [{ id: Url, domain: domainOf(Url) }] : []));
}

/** Bing answers its whole history at once, so what's outside the period is left out here. It says no position per day. */
function daysWithin(rows: { Date?: string; Clicks?: number; Impressions?: number }[], from: string, to: string): EngineDay[] {
  const byDay = new Map<string, EngineDay>();
  for (const { Date: date, Clicks = 0, Impressions = 0 } of rows) {
    const day = bingMoment(date)?.toISOString().slice(0, 10);
    if (!day || day < from || day > to) continue;
    const known = byDay.get(day) ?? { day, clicks: 0, impressions: 0, position: null };
    byDay.set(day, { ...known, clicks: known.clicks + Clicks, impressions: known.impressions + Impressions });
  }
  return [...byDay.values()];
}

const sitemapOf = ({ Url, Submitted, LastCrawled, UrlCount = 0 }: { Url?: string; Submitted?: string; LastCrawled?: string; UrlCount?: number }): EngineSitemap[] => (Url ? [{ url: Url, submittedAt: bingMoment(Submitted), lastReadAt: bingMoment(LastCrawled), errors: 0, warnings: 0, urls: UrlCount }] : []);

export const bingAdapter: Adapter = (context): AdapterClient => {
  const api = apiOf(context);
  return {
    engine: "bing",
    check: () =>
      checked(NAME, async () => {
        const properties = await propertiesOf(api);
        // No label of its own: one holding the count of sites would make a new connection whenever that changes.
        return { ok: true, detail: `Bing answers: ${properties.length} sites.` };
      }),
    properties: () => propertiesOf(api),
    days: async (property, from, to) => daysWithin((await api.get<{ Date?: string; Clicks?: number; Impressions?: number }[]>("GetRankAndTrafficStats", { siteUrl: property })) ?? [], from, to),
    sitemaps: async (property) => ((await api.get<Parameters<typeof sitemapOf>[0][]>("GetFeeds", { siteUrl: property })) ?? []).flatMap(sitemapOf),
    submitSitemap: async (property, url) => void (await api.post("SubmitFeed", { siteUrl: property, feedUrl: url })),
  };
};
