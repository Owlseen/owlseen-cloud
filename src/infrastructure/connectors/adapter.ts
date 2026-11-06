import type { ConnectorClient, IndexStatus, KeywordsAndPages, SearchFigures, Sitemaps } from "@/application/ports";

/** What an adapter is given to talk to its service: the connection's fields as saved, and `fetch` and waiting, both replaceable in tests. */
export interface AdapterContext {
  fields: Readonly<Record<string, string>>;
  fetch: typeof fetch;
  /** Called after a refusal for going too fast. */
  wait: (ms: number) => Promise<void>;
}

/** An adapter's client: the check every connection has, and the ports of its connector's capabilities. */
export type AdapterClient = ConnectorClient & Partial<SearchFigures & KeywordsAndPages & IndexStatus & Sitemaps>;

export type Adapter = (context: AdapterContext) => AdapterClient;
