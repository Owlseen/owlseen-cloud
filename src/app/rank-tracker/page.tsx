import type { Metadata } from "next";
import { Suspense } from "react";
import { mostClicked, type TrackedKeyword, trackedKeywordsOf } from "@/application/rank-tracker";
import type { SiteRow } from "@/application/sites";
import { periodEndingAt } from "@/application/time-range";
import { Change, formatted, MiniColumns, positionOf } from "@/components/charts";
import { daysIn, NoSitesYet, SiteAndPeriod, type Query } from "@/components/reading";
import { readingContext } from "@/components/reading-context";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { ActionForm, TryButton } from "@/components/try-button";
import { Card, EmptyState, INLINE_FIELD, ROWS } from "@/components/ui";
import { db } from "@/infrastructure/db/client";
import { trackAction, untrackAction } from "./actions";

const MOST_SHOWN = 100;

export const metadata: Metadata = { title: "Rank tracker" };

/** Higher on the chart is better, and a position counts down: a column is how far from the 100th place it stands. */
const heightOfPosition = (position: number | null) => (position === null ? 0 : Math.max(101 - position, 1));

function TrackedRow({ row, sites }: { row: TrackedKeyword; sites: number }) {
  return (
    <li data-tracked={row.text} className="flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-3 text-sm">
      <span className="min-w-48 flex-1 truncate font-medium">
        {row.text}
        {sites > 1 && <span className="ml-2 text-xs font-normal text-muted-foreground">{row.siteName}</span>}
      </span>
      <MiniColumns values={row.history.map(heightOfPosition)} />
      <span className="w-20 text-right font-mono">pos. {positionOf(row.position)}</span>
      <span className="w-24 text-right">
        <Change now={row.position} before={row.positionBefore} lowerIsBetter />
      </span>
      <span className="w-20 text-right font-mono text-xs text-muted-foreground">{formatted(row.clicks)} clicks</span>
      <TryButton action={untrackAction.bind(null, row.siteId, row.id)} label="Stop" busy="…" />
    </li>
  );
}

function AddKeyword({ sites, site }: { sites: readonly SiteRow[]; site?: SiteRow }) {
  return (
    <Card className="mb-6">
      <h2 className="mb-3 text-sm font-semibold">Follow a keyword</h2>
      <ActionForm action={trackAction} submit="Follow" busy="…" className="flex flex-wrap items-center gap-2">
        <select name="site" defaultValue={site?.id ?? sites[0].id} aria-label="Site" className={INLINE_FIELD}>
          {sites.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <input name="keyword" required maxLength={300} placeholder="A keyword, seen in search yet or not" aria-label="Keyword" className={`${INLINE_FIELD} min-w-72 flex-1`} />
      </ActionForm>
    </Card>
  );
}

async function Content({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const { seat, sites, groups, chosen, reported } = await readingContext(query);
  if (sites.length === 0) return <NoSitesYet />;
  const days = daysIn(query);
  const tracked = await trackedKeywordsOf(db(), seat.workspaceId, chosen.scope, periodEndingAt(new Date(), days));
  return (
    <>
      <SiteAndPeriod action="/rank-tracker" sites={sites} groups={groups} chosen={chosen} days={days} reported={reported} />
      <AddKeyword sites={sites} site={chosen.site} />
      {tracked.length === 0 ? (
        <EmptyState title="No keyword followed yet">Follow the ones that matter, here or from the keywords page, to see their position day by day.</EmptyState>
      ) : (
        <>
          {tracked.length > MOST_SHOWN && <p className="mb-4 text-sm text-muted-foreground">The {MOST_SHOWN} most clicked of the {formatted(tracked.length)} followed. Choose a site or a group for the others.</p>}
          <ul className={ROWS}>
            {mostClicked(tracked, MOST_SHOWN).map((row) => (
              <TrackedRow key={row.id} row={row} sites={chosen.site ? 1 : sites.length} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/** The keywords a workspace follows, where they stand and how they moved. */
export default function RankTrackerPage({ searchParams }: PageProps<"/rank-tracker">) {
  return (
    <Shell section="rank-tracker">
      <PageHeading title="Rank tracker">The keywords you follow, with their position on Google day by day.</PageHeading>
      <Suspense fallback={<Loading />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}
