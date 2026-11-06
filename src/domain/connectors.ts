/**
 * Every service a workspace can connect, what each lets the app do, and how it is authorized. Pure
 * data: the screens list it, and each kind has one adapter in `infrastructure/connectors`.
 *
 * Secrets are always typed into the app's own connection page, never into a conversation: an
 * assistant's chat history is not a place for them.
 */

/** What a connection lets the app do; an adapter implements the matching port. */
export type Capability = "search_figures" | "keywords_and_pages" | "index_status" | "sitemaps";

export interface Field {
  key: string;
  label: string;
  /** Sealed with the rest of the credentials, never shown again once saved. */
  secret: boolean;
  optional?: boolean;
  placeholder?: string;
  help?: string;
}

export interface Connector {
  kind: ConnectorKind;
  name: string;
  /** One line, for the catalogue. */
  summary: string;
  capabilities: readonly Capability[];
  fields: readonly Field[];
  /** Where its data is processed, for the workspace's GDPR register. */
  hosting: "EU" | "US" | "EU or US";
  /** The provider's page that explains where to find what the fields ask for. */
  docs?: string;
  /** What a member does in the service's own console, step by step. Consoles change: `docs` stays the reference. */
  setup: readonly string[];
  /** Saved fields aren't enough: a member also has to allow access at the service, which comes back to this address. */
  consentCallback?: string;
}

export const CONNECTORS = [
  {
    kind: "google",
    name: "Google Search Console",
    summary: "Clicks, impressions, positions, keywords, pages, index status and sitemaps for every property your Google account can see.",
    capabilities: ["search_figures", "keywords_and_pages", "index_status", "sitemaps"],
    fields: [
      { key: "clientId", label: "Client ID", secret: true, placeholder: "1234-abc.apps.googleusercontent.com" },
      { key: "clientSecret", label: "Client secret", secret: true, help: "Google shows it when the client is created." },
    ],
    hosting: "US",
    docs: "https://developers.google.com/webmaster-tools/v1/how-tos/authorizing",
    setup: [
      "In the Google Cloud console, create a project of your company’s and enable the Google Search Console API.",
      "On its consent screen, publish the app (In production). In Testing, Google ends access after 7 days and the daily sync stops.",
      "Create an OAuth client of the Web application type, with the redirect address shown below.",
      "Type its ID and secret here, then allow access with a Google account that can see your properties.",
    ],
    consentCallback: "/api/connections/google/callback",
  },
  {
    kind: "bing",
    name: "Bing Webmaster Tools",
    summary: "Clicks and impressions per day, and sitemaps, for every site in your Bing account.",
    capabilities: ["search_figures", "sitemaps"],
    fields: [{ key: "apiKey", label: "API key", secret: true, help: "Generating a new one in Bing ends the old one, so reuse the one you have." }],
    hosting: "US",
    docs: "https://learn.microsoft.com/en-us/bingwebmaster/getting-access",
    setup: ["In Bing Webmaster Tools, open Settings, then API Access.", "Copy your API key and connect it here."],
  },
] as const satisfies readonly (Omit<Connector, "kind"> & { kind: string })[];

export type ConnectorKind = (typeof CONNECTORS)[number]["kind"];

const byKind = new Map<string, Connector>(CONNECTORS.map((connector) => [connector.kind, connector as Connector]));

export function connectorOf(kind: string): Connector | undefined {
  return byKind.get(kind);
}

/** What was typed for a connector, or which required fields are missing. Empty optional fields stay out, so they don't overwrite what's saved. */
export function readFields(connector: Connector, values: Record<string, unknown>): { ok: true; values: Record<string, string> } | { ok: false; missing: string[] } {
  const read: Record<string, string> = {};
  const missing: string[] = [];
  for (const field of connector.fields) {
    const value = typeof values[field.key] === "string" ? (values[field.key] as string).trim() : "";
    if (value) read[field.key] = value;
    else if (!field.optional) missing.push(field.label);
  }
  return missing.length ? { ok: false, missing } : { ok: true, values: read };
}
