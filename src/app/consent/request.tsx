import { BRAND } from "@/domain/brand";

const namedList = (names: string[]) => new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(names);

/** Where approving sends the code that opens a member's data: the one thing here its asker can't choose freely and still get it. */
export function hostOf(address: string | undefined): string | null {
  try {
    return address ? new URL(address).host : null;
  } catch {
    return null;
  }
}

export interface ConsentAsker {
  /** What it registered itself as. */
  name?: string;
  /** The address it gave as its own, which nothing checks. */
  website?: string;
  /** Where it would be sent back to. */
  sentBackTo: string | null;
}

/**
 * Anyone can register under any name and any website, so neither is said as a fact. Where the
 * approval is sent is what a member can actually check, so it's said on its own line.
 */
export function ConsentRequest({ asker, workspaces }: { asker: ConsentAsker; workspaces: readonly string[] }) {
  return (
    <>
      <h1 className="text-xl font-semibold tracking-[-0.025em]">
        {asker.name ? `An app calling itself “${asker.name}”` : "An app"} is asking for access to {BRAND}
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Anyone can register under any name, so that name proves nothing{asker.website ? `, and neither does the website it gives, ${hostOf(asker.website) ?? asker.website}` : ""}. Allow it only if you started this from that app just now.
      </p>
      <p className="mt-4 text-sm text-muted-foreground">Allowing it sends you back to:</p>
      <p data-sent-back-to className="mt-1 font-mono text-sm font-medium break-all">
        {asker.sentBackTo ?? "an address that can’t be read: refuse this"}
      </p>
      <p className="mt-4 text-sm text-muted-foreground">
        It will be able to act on your behalf {workspaces.length > 1 ? `in all your workspaces, ${namedList([...workspaces])}` : "in your workspace"}: read its sites’ figures, follow keywords, change groups of sites, make and revoke API keys, ask Google about a page, and submit a sitemap once you say so.
      </p>
      <p className="mt-3 text-sm text-muted-foreground">It keeps this access until you disconnect it from the assistant, or leave the workspace. If you leave, the API keys you made end too.</p>
    </>
  );
}
