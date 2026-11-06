import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { alertsOf, pagesDroppedOf, type SiteAlert, type SiteDrop } from "@/application/alerts";
import { connectionsNotWorking, type ConnectionView } from "@/application/connections";
import { overviewOf, type Overview } from "@/application/overview";
import { periodEndingAt } from "@/application/time-range";
import { Change, dayLabel, DayColumns, formatted, percent, positionOf } from "@/components/charts";
import { daysIn, LastSynced, NoSitesYet, SiteAndPeriod, type Query } from "@/components/reading";
import { readingContext } from "@/components/reading-context";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { Badge, Card } from "@/components/ui";
import { ctrOf, ENGINE_NAMES, lastReported } from "@/domain/search";
import { db } from "@/infrastructure/db/client";
import { appServices } from "@/infrastructure/services";

export const metadata: Metadata = { title: "Overview" };

function Totals({ totals, totalsBefore }: Pick<Overview, "totals" | "totalsBefore">) {
  const figures = [
    { label: "Clicks", value: formatted(totals.clicks), change: <Change now={totals.clicks} before={totalsBefore.clicks} /> },
    { label: "Impressions", value: formatted(totals.impressions), change: <Change now={totals.impressions} before={totalsBefore.impressions} /> },
    { label: "Click-through", value: percent(ctrOf(totals)), change: <Change now={ctrOf(totals)} before={ctrOf(totalsBefore)} /> },
    { label: "Average position", value: positionOf(totals.position), change: <Change now={totals.position} before={totalsBefore.position} lowerIsBetter /> },
  ];
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border md:grid-cols-4">
      {figures.map(({ label, value, change }) => (
        <div key={label} className="bg-card px-6 py-5">
          <dt className="text-sm text-muted-foreground">{label}</dt>
          <dd data-figure={label} className="mt-1 font-mono text-3xl tabular-nums tracking-tight">
            {value}
          </dd>
          <dd className="mt-1">{change}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Google and Bing side by side: each says what it knows, and Bing says no position. */
function Engines({ engines }: Pick<Overview, "engines">) {
  if (engines.length < 2) return null;
  return (
    <table className="mt-4 w-full max-w-xl text-sm">
      <thead className="text-left text-xs text-muted-foreground">
        <tr>
          <th className="pb-1 font-normal">Engine</th>
          <th className="pb-1 text-right font-normal">Clicks</th>
          <th className="pb-1 text-right font-normal">Impressions</th>
          <th className="pb-1 text-right font-normal">Click-through</th>
          <th className="pb-1 text-right font-normal">Position</th>
        </tr>
      </thead>
      <tbody>
        {[...engines].sort((a, b) => b.clicks - a.clicks).map((one) => (
          <tr key={one.engine} data-engine={one.engine} className="border-t">
            <td className="py-1.5">{ENGINE_NAMES[one.engine]}</td>
            <td className="py-1.5 text-right font-mono">{formatted(one.clicks)}</td>
            <td className="py-1.5 text-right font-mono">{formatted(one.impressions)}</td>
            <td className="py-1.5 text-right font-mono">{percent(ctrOf(one))}</td>
            <td className="py-1.5 text-right font-mono">{positionOf(one.position)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const SEVERITY_WORDS = { high: "Falling hard", medium: "Falling", info: "Rising" };

/** What a period's totals actually hold: "Last 7 days" with Google three days late is four days of Google. */
function Covers({ from, to, reportedUpTo }: Pick<Overview, "from" | "to" | "reportedUpTo">) {
  const last = lastReported(reportedUpTo);
  if (!last) return <p className="mb-3 text-sm text-muted-foreground">Nothing has been reported yet.</p>;
  if (last < from) return <p data-covers className="mb-3 text-sm text-muted-foreground">The engines list nothing here since {dayLabel(last)}.</p>;
  const upTo = last < to ? last : to;
  return (
    <p data-covers className="mb-3 text-sm text-muted-foreground">
      {dayLabel(from)} to {dayLabel(upTo)}{last < to ? ", the days reported so far," : ""} against the same days a period earlier.
    </p>
  );
}

function Alerts({ alerts, drops, notWorking }: { alerts: SiteAlert[]; drops: SiteDrop[]; notWorking: ConnectionView[] }) {
  if (alerts.length === 0 && drops.length === 0 && notWorking.length === 0) return null;
  return (
    <Card className="mt-4">
      <h2 className="text-sm font-semibold">What moved this week</h2>
      <ul className="mt-3 space-y-2 text-sm">
        {notWorking.map(({ id, kind, label, lastError }) => (
          <li key={id} data-not-working={kind} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Badge tone="alert">Not being read</Badge>
            <Link href={`/connections/${kind}`} className="font-medium hover:underline">
              {label}
            </Link>
            {lastError && <span className="text-xs text-muted-foreground">{lastError}</span>}
          </li>
        ))}
        {alerts.map(({ siteId, siteName, severity, clicks, clicksBefore, quietSince }) => (
          <li key={siteId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Badge tone={severity === "info" ? "calm" : "alert"}>{quietSince ? "Gone quiet" : SEVERITY_WORDS[severity]}</Badge>
            <Link href={`/overview?site=${siteId}`} className="font-medium hover:underline">
              {siteName}
            </Link>
            <span className="font-mono text-xs text-muted-foreground">
              {quietSince ? `nothing since ${dayLabel(quietSince)}, ${formatted(clicksBefore)} clicks before that` : `${formatted(clicksBefore)} → ${formatted(clicks)} clicks`}
            </span>
          </li>
        ))}
        {drops.map(({ siteId, siteName, pages }) => (
          <li key={`dropped ${siteId}`} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Badge tone="alert">Left the index</Badge>
            <Link href={`/indexing?site=${siteId}`} className="font-medium hover:underline">
              {siteName}
            </Link>
            <span className="font-mono text-xs text-muted-foreground">
              {formatted(pages)} {pages === 1 ? "page" : "pages"}
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
  const [overview, alerts, drops, notWorking] = await Promise.all([overviewOf(db(), seat.workspaceId, { sites: chosen.scope, period: periodEndingAt(now, days) }), alertsOf(db(), seat.workspaceId, chosen.scope, now), pagesDroppedOf(db(), seat.workspaceId, chosen.scope, now), connectionsNotWorking(appServices(), seat.workspaceId)]);
  return (
    <>
      <SiteAndPeriod action="/overview" sites={sites} groups={groups} chosen={chosen} days={days} reported={reported} />
      <Covers from={overview.from} to={overview.to} reportedUpTo={overview.reportedUpTo} />
      <Totals totals={overview.totals} totalsBefore={overview.totalsBefore} />
      <Engines engines={overview.engines} />
      <Card className="mt-4">
        <h2 className="mb-3 text-sm font-semibold">Clicks</h2>
        <DayColumns days={overview.days.map(({ date, clicks }) => ({ date, value: clicks }))} measure="Clicks" reportedUpTo={lastReported(overview.reportedUpTo)} />
      </Card>
      <Alerts alerts={alerts} drops={drops} notWorking={notWorking} />
      <LastSynced at={overview.lastSyncedAt} />
    </>
  );
}

/** One site's search, or a whole workspace's, against the period before. */
export default function OverviewPage({ searchParams }: PageProps<"/overview">) {
  return (
    <Shell section="overview">
      <PageHeading title="Overview">How your sites do in search, from Google and Bing. A figure is compared with the time just before, as far as the engines have reported.</PageHeading>
      <Suspense fallback={<Loading />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}
