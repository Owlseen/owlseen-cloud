import Form from "next/form";
import Link from "next/link";
import type { ReactNode } from "react";
import type { SiteScope } from "@/application/search-columns";
import type { SiteGroup } from "@/application/site-groups";
import type { SiteRow } from "@/application/sites";
import { boundedDays } from "@/application/time-range";
import { EmptyState, INLINE_FIELD, QuietButton } from "./ui";
import { when } from "./when";
import { ENGINE_NAMES, ENGINES, type Reported } from "@/domain/search";
import { dayLabel } from "./charts";

export type Query = Record<string, string | string[] | undefined>;

export const oneOf = (query: Query, name: string) => (typeof query[name] === "string" ? (query[name] as string) : undefined);

const PERIODS = [7, 28, 90, 365];

export const daysIn = (query: Query) => boundedDays(oneOf(query, "days"));

const GROUP_PREFIX = "group:";

export interface Chosen {
  /** What the picker shows as chosen. */
  value: string;
  /** What to read. */
  scope: SiteScope;
  /** The one site, when one is chosen. */
  site?: SiteRow;
}

/** What a page asked to read, among this workspace's sites and groups: otherwise everything. */
export function chosenIn(sites: readonly SiteRow[], groups: readonly SiteGroup[], query: Query): Chosen {
  const asked = oneOf(query, "site") ?? "";
  const group = groups.find(({ id }) => `${GROUP_PREFIX}${id}` === asked);
  if (group) return { value: asked, scope: group.siteIds };
  const site = sites.find(({ id }) => id === asked);
  return site ? { value: asked, scope: site.id, site } : { value: "", scope: null };
}

/** Which sites and how far back, at the top of every page that reads figures. */
export function SiteAndPeriod({ action, sites, groups, chosen, days, reported, children }: { action: string; sites: readonly SiteRow[]; groups: readonly SiteGroup[]; chosen: Chosen; days?: number; reported?: Reported; children?: ReactNode }) {
  return (
    <>
      <Form action={action} className={`flex flex-wrap items-center gap-2 ${reported ? "mb-2" : "mb-6"}`}>
        <select name="site" defaultValue={chosen.value} aria-label="Sites" className={INLINE_FIELD}>
          <option value="">All sites</option>
          {groups.length > 0 && (
            <optgroup label="Groups">
              {groups.map(({ id, name, siteIds }) => (
                <option key={id} value={`${GROUP_PREFIX}${id}`}>
                  {name} ({siteIds.length})
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Sites">
            {sites.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </optgroup>
        </select>
        {days !== undefined && (
          <select name="days" defaultValue={String(days)} aria-label="Period" className={INLINE_FIELD}>
            {[...new Set([...PERIODS, days])]
              .sort((a, b) => a - b)
              .map((length) => (
                <option key={length} value={length}>
                  Last {length} days
                </option>
              ))}
          </select>
        )}
        {children}
        <QuietButton type="submit">Show</QuietButton>
      </Form>
      {reported && <ReportedUpTo reported={reported} />}
    </>
  );
}

/** Engines report days late, and a period's last days aren't quiet ones: every page that shows figures says how far they go. */
export function ReportedUpTo({ reported }: { reported: Reported }) {
  const said = ENGINES.flatMap((engine) => {
    const day = reported[engine];
    return day ? [`${ENGINE_NAMES[engine]} has reported up to ${dayLabel(day)}`] : [];
  });
  if (said.length === 0) return <p className="mb-6 text-xs text-muted-foreground">No engine has reported anything here yet.</p>;
  return <p data-reported-up-to className="mb-6 text-xs text-muted-foreground">{said.join(", ")}: the figures here go no further. Engines report days late.</p>;
}

/** How old what's on the page is: figures are read once a day. */
export function LastSynced({ at }: { at: Date | null }) {
  return <p className="mt-6 text-xs text-muted-foreground">{at ? `Read from the engines ${when(at)}.` : "Nothing read from the engines yet."}</p>;
}

export function NoSitesYet() {
  return (
    <EmptyState title="No sites yet">
      <Link href="/connections" className="text-link hover:underline">
        Connect Google or Bing
      </Link>
      , then{" "}
      <Link href="/sites" className="text-link hover:underline">
        choose which sites to follow
      </Link>
      .
    </EmptyState>
  );
}
