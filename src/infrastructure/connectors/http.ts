/**
 * Calls to providers' APIs, with their failures said in the member's words: a refused key, a
 * quota reached, a provider down. The provider's own message is kept when it gives one as JSON,
 * since it usually says which field is wrong.
 */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
    /** How long the provider asked to be left alone. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** How long a provider gets to answer: a hung one would otherwise hold a job past its deadline. */
const ANSWER_WITHIN_MS = 30_000;
/** A provider asking for longer than this is left for the next run: a job has minutes, and others are waiting. */
const LONGEST_WAIT_MS = 60_000;
/** No answer at all, in time: a hung service gets no second try, or one would use up a whole run. */
const NO_ANSWER = 0;
/** No answer at all, at once: the network, which usually comes back. */
const UNREACHABLE = 503;
const UNREADABLE = 502;

const WHY: Record<number, string> = {
  400: "refused the request",
  401: "refused the credentials",
  403: "refused access",
  404: "can’t find what was asked for",
  429: "is limiting requests: try again in a moment",
};

const LONGEST_MESSAGE = 300;

/**
 * The provider's error message, wherever its JSON puts it. An answer that isn't JSON says nothing here:
 * it's an error page or a proxy's, which can repeat the request and whatever key its address holds.
 */
function messageIn(body: string): string | undefined {
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const nested = json.error as { message?: unknown; text?: unknown } | undefined;
    const first = (json.errors as { message?: unknown }[] | undefined)?.[0];
    const candidate = json.message ?? json.Message ?? json.error_description ?? nested?.message ?? nested?.text ?? first?.message ?? json.error ?? json.detail ?? json.title;
    return typeof candidate === "string" ? candidate.slice(0, LONGEST_MESSAGE) : undefined;
  } catch {
    return undefined;
  }
}

/** What Retry-After says, as seconds or as a date; nothing when it's absent or already past. */
function retryAfterIn(response: Response): number | undefined {
  const said = response.headers.get("retry-after");
  if (!said) return undefined;
  const seconds = Number(said);
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(said) - Date.now();
  return ms > 0 ? ms : undefined;
}

/** The call itself, bounded in time. What the network says is left out: it can repeat the address, and a key with it. */
async function answerOf(fetchUrl: typeof fetch, provider: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchUrl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(ANSWER_WITHIN_MS) });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new ProviderError(provider, timedOut ? NO_ANSWER : UNREACHABLE, timedOut ? `${provider} didn’t answer in time.` : `${provider} couldn’t be reached.`);
  }
}

/** Sends the request and reads the answer as text; throws a ProviderError on anything but 2xx. */
async function requestText(fetchUrl: typeof fetch, provider: string, url: string, init: RequestInit): Promise<string> {
  const response = await answerOf(fetchUrl, provider, url, init);
  const body = await response.text();
  if (!response.ok) {
    const why = WHY[response.status] ?? (response.status >= 500 ? "isn’t answering properly right now" : `answered ${response.status}`);
    const detail = messageIn(body);
    throw new ProviderError(provider, response.status, `${provider} ${why}${detail ? `: ${detail}` : "."}`, retryAfterIn(response));
  }
  return body;
}

/** Sends the request and reads the JSON answer; throws a ProviderError on anything but 2xx, or an answer that can't be read. */
export async function requestJson<T>(fetchUrl: typeof fetch, provider: string, url: string, init: RequestInit = {}): Promise<T> {
  const body = await requestText(fetchUrl, provider, url, init);
  try {
    return (body ? JSON.parse(body) : undefined) as T;
  } catch {
    throw new ProviderError(provider, UNREADABLE, `${provider} gave an answer that can’t be read.`);
  }
}

/** JSON request headers with a bearer token. */
export const bearerJson = (token: string): HeadersInit => ({ authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" });

/**
 * A provider limiting how much it's asked: a 429, or as Google and Bing also say it, another status
 * naming a quota, a rate limit or a throttle. It's about the moment, never about the credentials.
 */
export const isQuota = (error: unknown): error is ProviderError => error instanceof ProviderError && (error.status === 429 || /quota|rate.?limit|throttle/i.test(error.message));

/** A provider refusing this account: its credentials, or a site out of its reach. */
export const isRefusal = (error: unknown): error is ProviderError => error instanceof ProviderError && (error.status === 401 || error.status === 403) && !isQuota(error);

/** Sends again what a service refused for going too fast, or failed at, waiting as long as it asks or longer each time. Anything else is an answer. */
export async function withRetries<T>(wait: (ms: number) => Promise<void>, send: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      const worthAnotherTry = isQuota(error) || (error instanceof ProviderError && error.status >= 500);
      if (!worthAnotherTry || attempt >= attempts || (error.retryAfterMs ?? 0) > LONGEST_WAIT_MS) throw error;
      await wait(error.retryAfterMs ?? 1_000 * 2 ** attempt);
    }
  }
}
