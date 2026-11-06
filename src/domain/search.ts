/**
 * What search figures mean, with nothing to fetch and nothing to store: the rules the screens, the
 * tools and the API share.
 */

export const ENGINES = ["google", "bing"] as const;
export type Engine = (typeof ENGINES)[number];

export const ENGINE_NAMES: Record<Engine, string> = { google: "Google", bing: "Bing" };

export interface Figures {
  clicks: number;
  impressions: number;
  /** Weighted by impressions. Null when nothing was shown, or the engine doesn't say. */
  position: number | null;
}

export const ctrOf = ({ clicks, impressions }: Pick<Figures, "clicks" | "impressions">) => (impressions > 0 ? clicks / impressions : 0);

/** Figures added up: a position only means something weighted by how often it was shown. */
export function combined(rows: readonly Figures[]): Figures {
  let clicks = 0;
  let impressions = 0;
  let weighted = 0;
  let weight = 0;
  for (const row of rows) {
    clicks += row.clicks;
    impressions += row.impressions;
    if (row.position !== null) {
      weighted += row.position * row.impressions;
      weight += row.impressions;
    }
  }
  return { clicks, impressions, position: weight > 0 ? weighted / weight : null };
}

// ─── Rank bands ────────────────────────────────────────────────────────────

export const RANK_BANDS = ["1-3", "4-10", "11-20", "21+"] as const;
export type RankBand = (typeof RANK_BANDS)[number];

export function rankBandOf(position: number): RankBand {
  if (position <= 3) return "1-3";
  if (position <= 10) return "4-10";
  return position <= 20 ? "11-20" : "21+";
}

// ─── Opportunities ─────────────────────────────────────────────────────────

/** What share of searchers click at each position, Google desktop and mobile together. Only an estimate, and only used as one. */
const CLICK_CURVE = [0.28, 0.15, 0.1, 0.07, 0.05, 0.04, 0.033, 0.028, 0.024, 0.02];
const BEYOND_THE_FIRST_PAGE = 0.012;

export function expectedCtrAt(position: number): number {
  if (position <= 1) return CLICK_CURVE[0];
  if (position > CLICK_CURVE.length) return BEYOND_THE_FIRST_PAGE;
  if (position === CLICK_CURVE.length) return CLICK_CURVE[position - 1];
  const below = Math.floor(position);
  const between = position - below;
  return CLICK_CURVE[below - 1] + (CLICK_CURVE[below] - CLICK_CURVE[below - 1]) * between;
}

/** Just off the first page, through the second: close enough for work to move it. */
export const STRIKING_DISTANCE = { from: 4, to: 20 } as const;
const LEAST_IMPRESSIONS = 20;
const TARGET_POSITION = 3;

export interface Opportunity {
  clicks: number;
  impressions: number;
  position: number;
  /** Clicks a period more, if it reached the target position. */
  potential: number;
}

/** Whether a keyword is worth working on, and for how many clicks. */
export function opportunityOf({ clicks, impressions, position }: Figures): Opportunity | null {
  if (position === null || impressions < LEAST_IMPRESSIONS) return null;
  if (position < STRIKING_DISTANCE.from || position > STRIKING_DISTANCE.to) return null;
  return { clicks, impressions, position, potential: Math.max(0, Math.round(impressions * expectedCtrAt(TARGET_POSITION) - clicks)) };
}

// ─── Alerts ────────────────────────────────────────────────────────────────

export type AlertSeverity = "high" | "medium" | "info";

export interface Alert {
  severity: AlertSeverity;
  change: number;
  clicks: number;
  clicksBefore: number;
  /** The engines list nothing since this day: all its traffic has gone. */
  quietSince?: string;
}

const LEAST_CLICKS_TO_COMPARE = 10;

/** A week against the one before. Below enough clicks, a swing says nothing. */
export function alertOf(clicks: number, clicksBefore: number, quietSince?: string): Alert | null {
  if (clicksBefore < LEAST_CLICKS_TO_COMPARE) return null;
  const change = (clicks - clicksBefore) / clicksBefore;
  const figures = { change, clicks, clicksBefore };
  if (quietSince) return { severity: "high", quietSince, ...figures };
  if (change <= -0.5) return { severity: "high", ...figures };
  if (change <= -0.25) return { severity: "medium", ...figures };
  return change >= 0.5 ? { severity: "info", ...figures } : null;
}

// ─── Pages losing their traffic ────────────────────────────────────────────

const LEAST_CLICKS_BEFORE_DECAY = 10;
const LEAST_PERCENT_LOST = 30;

export interface PeriodClicks {
  clicks: number;
  clicksBefore: number;
}

export function isDecaying({ clicks, clicksBefore }: PeriodClicks): boolean {
  // In whole numbers: 90 × 0.7 comes out just under 63, which would miss a page that lost exactly 30%.
  return clicksBefore >= LEAST_CLICKS_BEFORE_DECAY && (clicksBefore - clicks) * 100 >= clicksBefore * LEAST_PERCENT_LOST;
}

// ─── How far the engines have reported ─────────────────────────────────────

/** The last day each engine has reported. The days after it aren't quiet days: nothing is known of them yet. */
export type Reported = Partial<Record<Engine, string>>;

/** The last day anything has been reported, by any engine. */
export const lastReported = (reported: Reported): string | undefined => Object.values(reported).sort().at(-1);

// ─── Which property to read ─────────────────────────────────────────────────

/**
 * How much of a domain a Search Console property covers, the lower the better: a domain property
 * covers all of it, then its https root, then its http root, then a folder.
 */
export function reachOfProperty(property: string): number {
  if (property.startsWith("sc-domain:")) return 0;
  try {
    const { protocol, pathname } = new URL(property);
    if (pathname !== "/") return 3;
    return protocol === "https:" ? 1 : 2;
  } catch {
    return 3;
  }
}

// ─── Keywords that moved ───────────────────────────────────────────────────

const LEAST_CLICKS_TO_HAVE_MOVED = 10;
const LEAST_PERCENT_MOVED = 30;

export interface KeywordMove extends PeriodClicks {
  /** Clicks gained, or lost when it's negative. */
  gained: number;
}

/** Whether a keyword moved enough to mean something, either way, against the period before: from nothing to something counts. */
export function moveOf(clicks: number, clicksBefore: number): KeywordMove | null {
  if (Math.max(clicks, clicksBefore) < LEAST_CLICKS_TO_HAVE_MOVED) return null;
  const gained = clicks - clicksBefore;
  // In whole numbers: 0.3 of a figure can land just over it, and a move of exactly 30% wouldn't count.
  return Math.abs(gained) * 100 >= Math.max(clicks, clicksBefore) * LEAST_PERCENT_MOVED ? { clicks, clicksBefore, gained } : null;
}

// ─── Index status ──────────────────────────────────────────────────────────

/** What the engine says of a page that's in its index: its other verdicts mean it isn't. */
export const INDEXED_VERDICT = "PASS";

export interface IndexState {
  day: string;
  verdict: string;
  coverage: string | null;
}

export type IndexStanding = { state: "indexed" } | { state: "not-indexed" } | { state: "dropped"; since: string; coverage: string | null };

/** Where a page stands from its checks, in any order: dropped means an earlier one had it indexed and the latest doesn't, since the first check to miss it. */
export function indexStandingOf(checks: readonly IndexState[]): IndexStanding {
  const latest = checks.reduce((newest, check) => (check.day > newest.day ? check : newest));
  if (latest.verdict === INDEXED_VERDICT) return { state: "indexed" };
  const lastIndexed = checks.reduce((last, { day, verdict }) => (verdict === INDEXED_VERDICT && day > last ? day : last), "");
  if (!lastIndexed) return { state: "not-indexed" };
  const since = checks.reduce((first, { day }) => (day > lastIndexed && day < first ? day : first), latest.day);
  return { state: "dropped", since, coverage: latest.coverage };
}
