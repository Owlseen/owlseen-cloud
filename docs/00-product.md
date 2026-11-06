# Owlseen

> Status: under construction. How a company's sites do in search, from Google Search Console and Bing, usable from screens and from an assistant.

## 1. What it does

A company with several sites shouldn't have to open a console per site, per engine, to know which are moving and why. Owlseen reads each site's figures once a day from the accounts a workspace connects, keeps them, and shows them together.

1. **Workspaces.** A workspace is a company: its members, its connections and its sites, kept apart from every other by row-level security.
2. **Connections.** A workspace connects its own Google OAuth client and its own Bing key. They're typed on its Connections page and sealed. Nothing a company owns lives in the environment.
3. **Sites.** What a workspace follows, chosen from what its connected accounts can see. One domain is one site, whichever engines it's on.
4. **Groups.** Sites read together, the way a company thinks of them: a business, a language, a client. A site can be in several, and a group can be chosen wherever a site can.
5. **Days.** Each site's figures per day, in total and per keyword and page. Every screen reads these, so a chart costs no quota and the database can sleep.

A day is whichever day the engine says it is: Google's run on Pacific time, and it reports only days it has finished, usually two or three days late. A period is counted back from today's date in UTC, so its last days are often empty.

## 2. Connections

| Connector | Gives | How it's authorized |
|---|---|---|
| Google Search Console | Figures, keywords and pages, index status, sitemaps | The workspace's own OAuth client, then a member allows access with an account that can see the properties |
| Bing Webmaster Tools | Figures, sitemaps | The account's API key |

**Google.** Each workspace creates its own client in Google Cloud, with the Search Console API enabled, published on its consent screen (in Testing, Google ends access after 7 days), and with `<address>/api/connections/google/callback` as its redirect address. What it asks for is `webmasters`, which reads figures and submits sitemaps, because Search Console has no narrower scope that does both, plus `openid email` to name the connection. The lasting token is sealed with the rest.

Credentials are sealed with AES-256-GCM and `OWLSEEN_SECRETS_KEY`, so a database dump alone reveals none of them. A connection is checked against its service before anything is saved, and only owners and admins change them.

## 3. Reading

The job at `/api/cron/sync` runs a few times each morning, and carries on where the last run stopped, so a large workspace can take several.

- **A site's first read** asks 480 days of totals and 90 days of keywords and pages. Later reads go back 10 days from when that engine was last read to the end, or from today if that's later: engines report late, a recent day keeps changing, and whatever a run of failures missed gets filled in. Keywords and pages are read 14 days at a time, each slice saved with how far it got, so a read that's stopped carries on from there. A stretch that fills every page, fails or times out is read again in halves.
- **A day's rows are replaced**, never added to, so reading twice changes nothing.
- **A site is done for the day when every engine that can be read was.** An engine with no account or a dead key leaves a note on its row, and the others aren't read again until tomorrow. An engine connected later still gets its first read from the start. A site whose engine only failed for now stays due, and what was read isn't asked twice.
- **A failure stays with its site.** A read says it hasn't finished before it starts, so one the platform stops is known for what it is. Sites failing go after the others, so one can't use up every run, with the last fifth of reading's time kept for them, so that they're still tried. Connecting an account again clears what its sites said and reads them first. Only refused credentials, a 401, mark a connection as failing: a 403 is about that one site, and a quota is about the moment. With several accounts on one engine, each is asked in turn until one reads the site. One workspace's broken connection stops nothing for the others.
- **Index status.** With the time left, a few pages at a time and each site's in turn, the site asked longest ago first, up to 100 pages a site a run, those never asked or asked longest ago first. A page is asked again no sooner than a week later, and a site with many pages takes longer than a week to go round: Google allows 2,000 a site a day, and a run only has minutes. A page Google won't answer about goes to the back of the queue, and a site out of quota waits for the next run. Only pages seen in search get asked: a page nobody has ever been shown is one Owlseen doesn't know about.

**Sleeping.** With no site at all, the job answers from the platform's cache and doesn't wake the database. Reads are at most a few a day, and screens read stored figures, so a database that bills by the hour it's awake stays asleep the rest of the time.

## 4. Screens

- **Overview** (`/overview`). One site, a group or a whole workspace: clicks, impressions, click-through and average position against the period before, a chart per day, each engine's share, and what moved this week.
- **Sites** (`/sites`). A card per site: its trend, its figures, how its keywords rank, when it was last read, and links through to its keywords, pages and indexing. Owners and admins add and remove sites and groups here.
- **Keywords** (`/keywords`). What people searched to find a site, the most clicked first. *What moved* lists those whose clicks moved by 30% or more against the time just before, from at least 10 clicks. *Worth working on* lists those just off the first page or on the second, with an estimate of the clicks they'd bring at position 3.
- **Pages** (`/pages`). The pages search brought people to, and those losing their clicks.
- **Rank tracker** (`/rank-tracker`). The keywords a workspace follows, with their position day by day.
- **Indexing** (`/indexing`). How many checked pages are indexed, which dropped out and since when, what the engines know of each sitemap, a page asked about on the spot, and a sitemap submitted.
- **Settings.** The team and invitations, connections, connecting an assistant, API keys.

Engines report days late, and list nothing for a day with no impressions, so what's measured against the time before depends on why rows stop. Each day is set against the one a whole period earlier, and today is never compared. For an engine read to the end since yesterday began, silence means nothing happened: the comparison runs as far as that engine has reported on the workspace's other sites, up to four days ago, what it can't have reported yet stays out, and a site that has lost all its traffic is measured against the last stretch it had, for six weeks after its last row, and alerts as gone quiet, once its engine has got past that day on the workspace's other sites, or after about a week when it's alone. For an engine whose reads stopped, nothing is known: the comparison stops where its rows do, with nothing in the period it counts on neither side, and a connection whose credentials stopped working says so as the first thing under what moved. Every page with figures says how far each engine has reported, the days after it are drawn hollow, and the overview says which days its totals cover. What's derived is only as good as its rule: a site alerts when its clicks fall 25% or more week on week, or rise 50% or more, from at least 10 clicks; a page is losing clicks when it fell 30% or more over four weeks, from at least 10; an opportunity needs at least 20 impressions at a position from 4 to 20. Keywords and pages come from Google: Bing gives totals and sitemaps here.

## 5. Assistants and figures

The MCP server is at `/api/mcp`, over streamable HTTP. An assistant registers itself, a member signs in and approves it, and every tool runs as that member with the same rules as the screens: each is the same use case the screens call. With several workspaces, every tool names one on each call: there is no current workspace.

| Tool | What it does |
|---|---|
| `list_workspaces` | The member's workspaces. |
| `list_sites`, `sites_followed` | The sites, with their figures, or only their names and what they're called in each engine. |
| `site_overview` | One site's overview over a period, a group's, or the whole workspace's. |
| `list_groups`, `save_group`, `remove_group` | The groups sites are read by. Any tool that reads a site also takes a group. Changing one is for owners and admins. |
| `alerts` | What moved this week, sites with pages that left the index included. |
| `top_keywords`, `top_pages` | What brings people. |
| `opportunities` | Keywords worth working on. |
| `keywords_that_moved` | Keywords whose clicks moved by 30% or more, up or down. |
| `pages_losing_clicks` | Pages losing their traffic. |
| `tracked_keywords`, `track_keyword`, `untrack_keyword` | Keywords followed. |
| `index_status`, `inspect_url` | Which pages are indexed, and asking Google about one now. |
| `submit_sitemap` | Tells an engine about a sitemap, for an owner or an admin, once the member has said yes. |
| `list_api_keys`, `create_api_key`, `revoke_api_key` | For an owner or an admin: read keys. |

Keywords are what strangers typed into a search engine, so the tools that return them say they're data, never instructions. Adding a site, connecting an account and managing members stay on the screens.

**Figures.** `GET /api/v1/figures`, `Authorization: Bearer sk_…`, with a key holding the `figures:read` scope. `days` is 1 to 365, 30 by default, and `site` is a site's id, every site by default, 50 sites to a page: `page` asks for the next one, and `nextPage` says whether there is one. `reportedUpTo` says how far each engine has reported: a zero after that day isn't a quiet day, it isn't known yet. Both engines together, per day. It names the workspace the key opens. Refusals: `401` for a missing or unknown key, `403` for a key without the scope, `400` for a `site` that isn't an id.

```json
{
  "workspace": { "id": "…", "name": "Acme" },
  "from": "2026-11-04",
  "to": "2026-11-05",
  "dayNote": "Days are as each engine reports them: Google’s run on Pacific time.",
  "reportedUpTo": { "google": "2026-11-03", "bing": "2026-11-05" },
  "sites": [
    {
      "id": "…",
      "name": "acme.example",
      "lastSyncedAt": "2026-11-05T06:00:03.000Z",
      "days": [{ "date": "2026-11-05", "clicks": 3, "impressions": 60, "position": 7.2, "ctr": 0.05 }]
    }
  ],
  "nextPage": null
}
```

**One keyword or one page.** `GET /api/v1/figures/breakdown?site=…&dimension=keyword&value=acme`, or `dimension=page&value=https://acme.example/pricing`, with the same key and `days`: its figures per day, on every day of the period. The caller names what it wants, so this lists nothing a key didn't already know. `400` for another dimension or no value, `404` for a site of another workspace.

## 6. Storing

Postgres, with no extension. Typed columns rather than JSON, since a row a day per keyword is most of what's stored, and the words of keywords and pages are kept once per site. A test reads the database and fails on a table that belongs to a workspace and isn't protected.

**Who sees what.** There are three kinds of table:

- **What belongs to a workspace** (every table with a `workspace_id`, listed below, plus `invitation`, `connection` and `api_key`) has row-level security, with a policy for the role `tenant_app`: `workspace_id = app_workspace_id()`. Its foreign keys to a site, a keyword, a page or a group include the workspace, so a row can't point at another workspace's, whatever a query does.
- **`workspace` and `member`** have the same policy, and `tenant_app` can only read them. They're written on the trusted path.
- **Identity** (`user`, `session`, `account`, `verification`, the OAuth tables, `jwks`, `rate_limit`) has no row-level security, and `tenant_app` has no grant on it: only the trusted path reaches it.

**How scoping works.** `withWorkspace` opens a transaction, sets `app.workspace_id` to the workspace and the role to `tenant_app`, both for that transaction only. Everything a screen, a tool or the API reads for a workspace goes through it. Whatever doesn't runs as the role the app connected with and sees every workspace: sign-in, membership checks, reading a key by its hash, and the job finding what's due. That path is what the code must get right; row-level security can't help it.

**How to run it yourself.** Connect with a role that owns the tables, which it does if it ran the migration. Row-level security isn't forced, on purpose: it doesn't bind the owner, and that's what the trusted path needs. Forcing it would change nothing for a role with `BYPASSRLS`, such as Neon's owner, and would leave a plain owner reading nothing. The role must be able to create `tenant_app`, or be the one that made it: on a cluster where another owner already made a `tenant_app`, the migration stops, so give Owlseen its own cluster or have that owner grant it. Never connect the app as `tenant_app`, and note that row-level security limits queries, not the connection: a role can leave `tenant_app` with `SET ROLE`, so the app never runs SQL it was given.

| Table | Holds |
|---|---|
| `site` | What's followed, what each engine calls it, when it was last read |
| `site_group`, `site_group_member` | Sites read together |
| `search_day` | A site's totals per day, per engine |
| `keyword`, `keyword_day` | The words, and their figures per day |
| `page`, `page_day` | The addresses, and their figures per day |
| `tracked_keyword` | What a workspace follows |
| `index_check` | A page's index status on a day it was asked |
| `sitemap` | What an engine last said of a sitemap |

## 7. Running it

The figures only arrive if something calls `GET /api/cron/sync` with `Authorization: Bearer $CRON_SECRET`. One call gets 270 seconds, then stops and leaves the rest for the next call. [The daily read](01-daily-read.md) works out what a large workspace needs: `vercel.json` calls it six times each morning.

That needs Vercel's Pro plan: Hobby only allows cron jobs once a day, and refuses to deploy a project that asks for more. On Hobby, or anywhere else, remove `crons` from `vercel.json` and call the address from any scheduler. The function needs a limit of 300 seconds to use its 270.

## 8. Planned

None of this exists yet: site audits, the links between a company's sites, keyword research, PageSpeed and Core Web Vitals, adding domains to the engines by DNS, keywords and pages from Bing, importing history.
