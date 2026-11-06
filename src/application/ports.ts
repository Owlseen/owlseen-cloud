import type { Engine } from "@/domain/search";

/**
 * What the use cases ask of a connected service, one port per capability. Each adapter in
 * `infrastructure/connectors` implements `ConnectorClient` and the ports of the capabilities its
 * connector lists; the use cases never know which provider is behind a port.
 */

/** Whether the service accepts what was saved, and what to call the connection. */
export interface Check {
  ok: boolean;
  /** Why not, or what was found, in the member's words. */
  detail: string;
  /** A name for the connection. */
  label?: string;
}

export interface ConnectorClient {
  check(): Promise<Check>;
}

/** A site as an engine lists it. */
export interface SearchProperty {
  /** The engine's name for it. */
  id: string;
  /** Its domain, without www: how the same site is recognised across engines. */
  domain: string;
}

export interface EngineDay {
  /** YYYY-MM-DD. */
  day: string;
  clicks: number;
  impressions: number;
  position: number | null;
}

/** A keyword's or a page's day. */
export interface NamedDay extends EngineDay {
  name: string;
  position: number;
}

export interface SearchFigures {
  engine: Engine;
  properties(): Promise<SearchProperty[]>;
  /** A site's totals per day. */
  days(property: string, from: string, to: string): Promise<EngineDay[]>;
}

/** What's been read of a stretch of days, and how far that goes: whoever stops can carry on from there. */
export interface NamedSlice {
  days: NamedDay[];
  through: string;
}

export interface KeywordsAndPages {
  keywordSlices(property: string, from: string, to: string): AsyncIterable<NamedSlice>;
  pageSlices(property: string, from: string, to: string): AsyncIterable<NamedSlice>;
}

export interface Inspection {
  verdict: string;
  coverage: string | null;
  lastCrawlAt: Date | null;
}

export interface IndexStatus {
  inspect(property: string, url: string): Promise<Inspection>;
}

export interface EngineSitemap {
  url: string;
  submittedAt: Date | null;
  lastReadAt: Date | null;
  errors: number;
  warnings: number;
  urls: number;
}

export interface Sitemaps {
  engine: Engine;
  sitemaps(property: string): Promise<EngineSitemap[]>;
  submitSitemap(property: string, url: string): Promise<void>;
}
