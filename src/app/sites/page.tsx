import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { siteCardsOf, type SiteCard } from "@/application/site-cards";
import { sitesAvailable } from "@/application/sites";
import { periodEndingAt } from "@/application/time-range";
import { Change, formatted, MiniColumns, percent, positionOf } from "@/components/charts";
import { daysIn, SiteAndPeriod, type Query } from "@/components/reading";
import { readingContext } from "@/components/reading-context";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { ActionForm, ConfirmButton } from "@/components/try-button";
import { Card, EmptyState } from "@/components/ui";
import { when } from "@/components/when";
import { ctrOf, lastReported, RANK_BANDS } from "@/domain/search";
import { managesSettings } from "@/domain/team";
import { db } from "@/infrastructure/db/client";
import { ProviderError } from "@/infrastructure/connectors/http";
import { appServices } from "@/infrastructure/services";
import { addSitesAction, removeSiteAction } from "./actions";
import { SiteGroups } from "./site-groups";

export const metadata: Metadata = { title: "Sites" };

const BAND_SHADES: Record<(typeof RANK_BANDS)[number], string> = { "1-3": "bg-eye", "4-10": "bg-foreground/70", "11-20": "bg-data", "21+": "bg-muted" };

/** Where a site's keywords rank, as one bar: how much of it is near the top. */
function RankBar({ bands, keywords }: Pick<SiteCard, "bands" | "keywords">) {
  if (keywords === 0) return <span className="text-xs text-muted-foreground">no keywords yet</span>;
  return (
    <span className="flex h-1.5 w-full overflow-hidden rounded-full" title={RANK_BANDS.map((band) => `${band}: ${bands[band]}`).join(" · ")}>
      {RANK_BANDS.map((band) => (
        <span key={band} className={BAND_SHADES[band]} style={{ width: `${(bands[band] / keywords) * 100}%` }} />
      ))}
    </span>
  );
}

function SiteCardOf({ card, mayChange, notYet }: { card: SiteCard; mayChange: boolean; notYet: number }) {
  return (
    <li data-site={card.name} className="flex flex-col gap-3 rounded-lg border bg-card p-5 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/overview?site=${card.siteId}`} className="block truncate font-medium hover:underline">
            {card.name}
          </Link>
          <p className={`truncate text-xs ${card.lastSyncError ? "text-alert" : "text-muted-foreground"}`} title={card.lastSyncError ?? undefined}>
            {card.lastSyncError ?? (card.lastSyncedAt ? `Read ${when(card.lastSyncedAt)}` : "Waiting for its read")}
          </p>
        </div>
        <MiniColumns values={card.spark} notYet={notYet} />
      </div>
      <p className="flex flex-wrap items-baseline gap-x-3">
        <span className="font-mono text-2xl tabular-nums">{formatted(card.clicks)}</span>
        <span className="text-xs text-muted-foreground">clicks</span>
        <Change now={card.clicks} before={card.clicksBefore} />
      </p>
      <p className="font-mono text-xs text-muted-foreground">
        {formatted(card.impressions)} shown · {percent(ctrOf(card))} · pos. {positionOf(card.position)}
      </p>
      <div className="flex flex-col gap-1">
        <RankBar bands={card.bands} keywords={card.keywords} />
        <span className="text-xs text-muted-foreground">
          {formatted(card.keywords)} keywords, {card.tracked} followed
        </span>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-3 text-xs">
        <Link href={`/keywords?site=${card.siteId}`} className="text-link hover:underline">
          Keywords
        </Link>
        <Link href={`/pages?site=${card.siteId}`} className="text-link hover:underline">
          Pages
        </Link>
        <Link href={`/indexing?site=${card.siteId}`} className="text-link hover:underline">
          Indexing
        </Link>
        {mayChange && (
          <span className="ml-auto">
            <ConfirmButton action={removeSiteAction.bind(null, card.siteId)} label="Remove" confirm="Yes: forget this site and its figures" />
          </span>
        )}
      </div>
    </li>
  );
}

async function Available({ workspaceId }: { workspaceId: string }) {
  const available = await sitesAvailable(appServices(), workspaceId).catch((error) => {
    if (error instanceof ProviderError) return error.message;
    throw error;
  });
  if (typeof available === "string") return <p className="text-sm text-alert">{available}</p>;
  const missing = available.filter(({ added }) => !added);
  if (available.length === 0) return <p className="text-sm text-muted-foreground">Connect an account first: nothing here can see a site yet.</p>;
  if (missing.length === 0) return <p className="text-sm text-muted-foreground">You follow every site your connected accounts can see.</p>;
  return (
    <ActionForm action={addSitesAction} submit="Add these sites" busy="Adding…">
      <ul className="grid gap-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {missing.map(({ domain, googleProperty, bingSite }) => (
          <li key={domain}>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="domain" value={domain} defaultChecked />
              {domain}
              <span className="text-xs text-muted-foreground">{[googleProperty && "Google", bingSite && "Bing"].filter(Boolean).join(", ")}</span>
            </label>
          </li>
        ))}
      </ul>
    </ActionForm>
  );
}

async function Content({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const { seat, sites, groups, chosen, reported } = await readingContext(query);
  const days = daysIn(query);
  const period = periodEndingAt(new Date(), days);
  const cards = await siteCardsOf(db(), seat.workspaceId, period, chosen.scope);
  const last = lastReported(reported);
  const notYet = last ? period.days.filter((day) => day > last).length : 0;
  const mayChange = managesSettings(seat.role);
  return (
    <>
      {sites.length > 0 && <SiteAndPeriod action="/sites" sites={sites} groups={groups} chosen={chosen} days={days} reported={reported} />}
      {cards.length === 0 ? (
        <EmptyState title="No sites yet">Choose below what to follow. Figures arrive with the next daily read.</EmptyState>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {cards.map((card) => (
            <SiteCardOf key={card.siteId} card={card} mayChange={mayChange} notYet={notYet} />
          ))}
        </ul>
      )}
      {sites.length > 0 && <SiteGroups sites={sites} groups={groups} mayChange={mayChange} />}
      {mayChange && (
        <Card className="mt-6">
          <h2 className="mb-3 font-semibold">Add sites</h2>
          <Suspense fallback={<p className="text-sm text-muted-foreground">Asking your connected accounts…</p>}>
            <Available workspaceId={seat.workspaceId} />
          </Suspense>
        </Card>
      )}
    </>
  );
}

/** A card per site followed: enough to see at a glance which are moving. */
export default function SitesPage({ searchParams }: PageProps<"/sites">) {
  return (
    <Shell section="sites">
      <PageHeading title="Sites">A card per site, the most clicked first, so the one that moved stands out.</PageHeading>
      <Suspense fallback={<Loading />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}
