import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { keywordsOf, movedKeywordsOf, opportunitiesOf, type KeywordFigures, type KeywordOpportunity, type MovedKeyword } from "@/application/keywords";
import { periodEndingAt } from "@/application/time-range";
import { formatted, percent, positionOf } from "@/components/charts";
import { daysIn, NoSitesYet, oneOf, SiteAndPeriod, type Query } from "@/components/reading";
import { readingContext } from "@/components/reading-context";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { ActionForm } from "@/components/try-button";
import { EmptyState, INLINE_FIELD, ROWS } from "@/components/ui";
import { ctrOf } from "@/domain/search";
import { db } from "@/infrastructure/db/client";
import { trackAction } from "../rank-tracker/actions";

export const metadata: Metadata = { title: "Keywords" };

function Follow({ row }: { row: KeywordFigures }) {
  return (
    <ActionForm action={trackAction} submit="Follow" busy="…" quiet className="flex">
      <input type="hidden" name="site" value={row.siteId} />
      <input type="hidden" name="keyword" value={row.text} />
    </ActionForm>
  );
}

function KeywordRow({ row, sites, potential }: { row: KeywordFigures; sites: number; potential?: number }) {
  return (
    <li data-keyword={row.text} className="flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-3 text-sm">
      <span className="min-w-48 flex-1 truncate font-medium">
        {row.text}
        {sites > 1 && <span className="ml-2 text-xs font-normal text-muted-foreground">{row.siteName}</span>}
      </span>
      {potential !== undefined && <span className="w-28 text-right font-mono text-xs text-calm">+{formatted(potential)} clicks</span>}
      <span className="w-20 text-right font-mono">{formatted(row.clicks)}</span>
      <span className="w-24 text-right font-mono text-xs text-muted-foreground">{formatted(row.impressions)} shown</span>
      <span className="w-16 text-right font-mono text-xs text-muted-foreground">{percent(ctrOf(row))}</span>
      <span className="w-20 text-right font-mono text-xs whitespace-nowrap">pos. {positionOf(row.position)}</span>
      <Follow row={row} />
    </li>
  );
}

const VIEWS = [
  { view: "all", label: "All keywords" },
  { view: "opportunities", label: "Worth working on" },
  { view: "moved", label: "What moved" },
] as const;

function ViewTabs({ current, query }: { current: string; query: Query }) {
  const others = Object.fromEntries(Object.entries(query).filter(([key, value]) => key !== "view" && typeof value === "string")) as Record<string, string>;
  return (
    <nav aria-label="Which keywords" className="mb-4 flex gap-4 border-b text-sm text-muted-foreground">
      {VIEWS.map(({ view, label }) => (
        <Link key={view} href={`/keywords?${new URLSearchParams({ ...others, view })}`} aria-current={view === current ? "page" : undefined} className="-mb-px border-b-2 border-transparent py-2 hover:text-foreground aria-[current=page]:border-primary aria-[current=page]:text-foreground">
          {label}
        </Link>
      ))}
    </nav>
  );
}

function MovedRow({ row, sites }: { row: MovedKeyword; sites: number }) {
  return (
    <li data-keyword={row.text} className="flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-3 text-sm">
      <span className="min-w-48 flex-1 truncate font-medium">
        {row.text}
        {sites > 1 && <span className="ml-2 text-xs font-normal text-muted-foreground">{row.siteName}</span>}
      </span>
      <span className="font-mono text-xs text-muted-foreground">
        {formatted(row.clicksBefore)} → {formatted(row.clicks)} clicks
      </span>
      <span className={`w-16 text-right font-mono text-xs ${row.gained > 0 ? "text-calm" : "text-alert"}`}>
        {row.gained > 0 ? "+" : "−"}
        {formatted(Math.abs(row.gained))}
      </span>
    </li>
  );
}

const NOTHING = <EmptyState title="Nothing here for this period">Keywords arrive from Google with the daily read.</EmptyState>;

function Moved({ rows, sites }: { rows: MovedKeyword[]; sites: number }) {
  if (rows.length === 0) return NOTHING;
  return (
    <ul className={ROWS}>
      {rows.map((row) => (
        <MovedRow key={row.id} row={row} sites={sites} />
      ))}
    </ul>
  );
}

const viewIn = (query: Query) => {
  const asked = oneOf(query, "view");
  return asked === "opportunities" || asked === "moved" ? asked : "all";
};

async function Content({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const { seat, sites, groups, chosen, reported } = await readingContext(query);
  if (sites.length === 0) return <NoSitesYet />;
  const days = daysIn(query);
  const view = viewIn(query);
  const search = oneOf(query, "q")?.trim() || undefined;
  const asked = { sites: chosen.scope, period: periodEndingAt(new Date(), days), search };
  const sitesShown = chosen.site ? 1 : sites.length;
  const moved = view === "moved" ? await movedKeywordsOf(db(), seat.workspaceId, asked) : [];
  const rows: (KeywordFigures & { potential?: KeywordOpportunity["potential"] })[] = view === "moved" ? [] : view === "opportunities" ? await opportunitiesOf(db(), seat.workspaceId, asked) : await keywordsOf(db(), seat.workspaceId, asked);
  return (
    <>
      <SiteAndPeriod action="/keywords" sites={sites} groups={groups} chosen={chosen} days={days} reported={reported}>
        <input type="hidden" name="view" value={view} />
        <input name="q" defaultValue={search} placeholder="Holding these words" aria-label="Holding these words" className={INLINE_FIELD} />
      </SiteAndPeriod>
      <ViewTabs current={view} query={query} />
      {view === "opportunities" && <p className="mb-4 text-sm text-muted-foreground">Keywords just off the first page or on the second, with an estimate of the clicks they’d bring at position 3. Only an estimate.</p>}
      {view === "moved" && <p className="mb-4 text-sm text-muted-foreground">Keywords whose clicks moved by 30% or more against the time just before, as far as Search Console has reported, the biggest move first.</p>}
      {view === "moved" ? (
        <Moved rows={moved} sites={sitesShown} />
      ) : rows.length === 0 ? (
        NOTHING
      ) : (
        <ul className={ROWS}>
          {rows.map((row) => (
            <KeywordRow key={row.id} row={row} sites={sitesShown} potential={row.potential} />
          ))}
        </ul>
      )}
    </>
  );
}

/** What people searched to find these sites, and which of it is closest to paying off. */
export default function KeywordsPage({ searchParams }: PageProps<"/keywords">) {
  return (
    <Shell section="keywords">
      <PageHeading title="Keywords">What people searched to find your sites, from Google.</PageHeading>
      <Suspense fallback={<Loading />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}
