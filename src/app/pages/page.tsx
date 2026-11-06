import type { Metadata } from "next";
import { Suspense } from "react";
import { decayingPagesOf, pagesOf, type DecayingPage, type PageFigures } from "@/application/pages";
import { periodEndingAt } from "@/application/time-range";
import { formatted, percent, positionOf } from "@/components/charts";
import { daysIn, NoSitesYet, SiteAndPeriod, type Query } from "@/components/reading";
import { readingContext } from "@/components/reading-context";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { Card, EmptyState, ROWS } from "@/components/ui";
import { ctrOf } from "@/domain/search";
import { db } from "@/infrastructure/db/client";

export const metadata: Metadata = { title: "Pages" };

/** A page's address without what every page of a site shares. */
function shortUrl(url: string): string {
  try {
    const { hostname, pathname } = new URL(url);
    return `${hostname.replace(/^www\./, "")}${pathname}`;
  } catch {
    return url;
  }
}

function PageRow({ row }: { row: PageFigures }) {
  return (
    <li data-page={row.url} className="flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-3 text-sm">
      <a href={row.url} target="_blank" rel="noreferrer noopener" className="min-w-48 flex-1 truncate font-medium hover:underline">
        {shortUrl(row.url)}
      </a>
      <span className="w-20 text-right font-mono">{formatted(row.clicks)}</span>
      <span className="w-24 text-right font-mono text-xs text-muted-foreground">{formatted(row.impressions)} shown</span>
      <span className="w-16 text-right font-mono text-xs text-muted-foreground">{percent(ctrOf(row))}</span>
      <span className="w-20 text-right font-mono text-xs whitespace-nowrap">pos. {positionOf(row.position)}</span>
    </li>
  );
}

function Decaying({ pages }: { pages: DecayingPage[] }) {
  if (pages.length === 0) return null;
  return (
    <Card className="mb-6">
      <h2 className="text-sm font-semibold">Losing clicks, the last four weeks against the four before</h2>
      <ul className="mt-3 space-y-1 text-sm">
        {pages.map(({ url, clicks, clicksBefore, shareLost }) => (
          <li key={url} className="flex justify-between gap-4">
            <span className="truncate" title={url}>
              {shortUrl(url)}
            </span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {formatted(clicksBefore)} → {formatted(clicks)} <span className="text-alert">−{percent(shareLost)}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

async function Content({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const { seat, sites, groups, chosen, reported } = await readingContext(query);
  if (sites.length === 0) return <NoSitesYet />;
  const days = daysIn(query);
  const now = new Date();
  const [pages, decaying] = await Promise.all([pagesOf(db(), seat.workspaceId, { sites: chosen.scope, period: periodEndingAt(now, days) }), decayingPagesOf(db(), seat.workspaceId, chosen.scope, now)]);
  return (
    <>
      <SiteAndPeriod action="/pages" sites={sites} groups={groups} chosen={chosen} days={days} reported={reported} />
      <Decaying pages={decaying} />
      {pages.length === 0 ? (
        <EmptyState title="Nothing here for this period">Pages arrive from Google with the daily read.</EmptyState>
      ) : (
        <ul className={ROWS}>
          {pages.map((row) => (
            <PageRow key={row.url} row={row} />
          ))}
        </ul>
      )}
    </>
  );
}

/** The pages search brings people to, and which are losing it. */
export default function PagesPage({ searchParams }: PageProps<"/pages">) {
  return (
    <Shell section="pages">
      <PageHeading title="Pages">The pages search brought people to, from Google, the most clicked first.</PageHeading>
      <Suspense fallback={<Loading />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}
