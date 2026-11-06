import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { indexingOf, type SiteIndexing } from "@/application/indexing";
import { formatted } from "@/components/charts";
import { NoSitesYet, SiteAndPeriod, type Query } from "@/components/reading";
import { readingContext } from "@/components/reading-context";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { ActionForm } from "@/components/try-button";
import { Badge, Card, FIELD, INLINE_FIELD, SeenDot } from "@/components/ui";
import { when } from "@/components/when";
import { ENGINE_NAMES, ENGINES } from "@/domain/search";
import { managesSettings } from "@/domain/team";
import { db } from "@/infrastructure/db/client";
import { inspectAction, submitSitemapAction } from "./actions";

export const metadata: Metadata = { title: "Indexing" };

function Dropped({ dropped }: Pick<SiteIndexing, "dropped">) {
  if (dropped.length === 0) return null;
  return (
    <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
      {dropped.map(({ url, since, coverage }) => (
        <li key={url} className="flex items-center gap-2" title={url}>
          <SeenDot seen={false} />
          <span className="truncate">
            <span className="font-mono text-alert">{url}</span> since {since}
            {coverage ? `: ${coverage}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Sitemaps({ sitemaps }: Pick<SiteIndexing, "sitemaps">) {
  if (sitemaps.length === 0) return <p className="mt-3 text-xs text-muted-foreground">No sitemap known to the engines.</p>;
  return (
    <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
      {sitemaps.map(({ engine, url, urls, errors, lastReadAt }) => (
        <li key={`${engine} ${url}`} className="flex flex-wrap items-center gap-x-2">
          <Badge>{ENGINE_NAMES[engine]}</Badge>
          <span className="truncate">{url}</span>
          <span className="font-mono">{formatted(urls)} addresses</span>
          {errors > 0 && <span className="text-alert">{errors} errors</span>}
          {lastReadAt && <span>read {when(lastReadAt)}</span>}
        </li>
      ))}
    </ul>
  );
}

function SiteForms({ siteId }: { siteId: string }) {
  return (
    <div className="mt-4 grid gap-3 md:grid-cols-2">
      <ActionForm action={inspectAction.bind(null, siteId)} submit="Ask Google now" busy="Asking…" quiet>
        <input name="url" type="url" required placeholder="https://… a page of this site" aria-label="Page to ask about" className={FIELD} />
      </ActionForm>
      <ActionForm action={submitSitemapAction.bind(null, siteId)} submit="Submit this sitemap" busy="Submitting…" quiet>
        <div className="flex gap-2">
          <select name="engine" aria-label="Engine" className={INLINE_FIELD}>
            {ENGINES.map((engine) => (
              <option key={engine} value={engine}>
                {ENGINE_NAMES[engine]}
              </option>
            ))}
          </select>
          <input name="url" type="url" required placeholder="https://… /sitemap.xml" aria-label="Sitemap address" className={FIELD} />
        </div>
      </ActionForm>
    </div>
  );
}

function SiteCard({ site, withForms }: { site: SiteIndexing; withForms: boolean }) {
  return (
    <Card>
      <h2 className="font-semibold">
        <Link href={`/indexing?site=${site.siteId}`} className="hover:underline">
          {site.siteName}
        </Link>
      </h2>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
        {site.checked > 0 && <SeenDot seen />}
        {site.checked === 0 ? "No page checked yet." : `${formatted(site.indexed)} of ${formatted(site.checked)} checked pages are indexed.`}
        {site.dropped.length > 0 && <span className="text-alert"> {site.dropped.length} dropped out.</span>}
      </p>
      <Dropped dropped={site.dropped} />
      <Sitemaps sitemaps={site.sitemaps} />
      {withForms && <SiteForms siteId={site.siteId} />}
    </Card>
  );
}

async function Content({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const { seat, sites, groups, chosen } = await readingContext(query);
  if (sites.length === 0) return <NoSitesYet />;
  const indexing = await indexingOf(db(), seat.workspaceId, chosen.scope, new Date());
  return (
    <>
      <SiteAndPeriod action="/indexing" sites={sites} groups={groups} chosen={chosen} />
      <div className="space-y-4">
        {indexing.map((one) => (
          <SiteCard key={one.siteId} site={one} withForms={Boolean(chosen.site) && managesSettings(seat.role)} />
        ))}
      </div>
    </>
  );
}

/** Which pages Google has indexed, which dropped out and when, and what the engines know of the sitemaps. */
export default function IndexingPage({ searchParams }: PageProps<"/indexing">) {
  return (
    <Shell section="indexing">
      <PageHeading title="Indexing">A share of each site’s pages is asked about every day, those asked longest ago first. Google only says what’s true now, so this is what remembers a page dropping out.</PageHeading>
      <Suspense fallback={<Loading />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}
