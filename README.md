# Owlseen

How your sites do in search: positions, keywords, pages and what dropped out of the index, for all of a company's sites, from Google Search Console and Bing, usable from screens and from an assistant (Claude or ChatGPT, through MCP). One app on Next.js and Postgres, with no cloud service you don't control. Open source (AGPL-3.0), self-hostable, with no seats or credits. See [docs/00-product.md](docs/00-product.md).

**Under construction.** This is a first version.

## What works today

- **Connections**: each workspace connects its own Google OAuth client and Bing key, on its Connections page, sealed. Nothing a company owns lives in environment variables.
- **A daily read**: each site's figures per day, in total and per keyword and page, stored in typed tables, so screens spend no quota and the database can sleep.
- **Screens**: an overview per site, per group and across a workspace, a card per site with how its keywords rank, keywords with those worth working on and those that moved, pages and those losing clicks, a rank tracker, and indexing with a history of what dropped out.
- **Assistants**: an MCP server at `/api/mcp` over OAuth, to read figures, keywords, pages and index status, follow keywords, group sites, manage API keys and submit sitemaps.
- **Figures**: `GET /api/v1/figures` per site and per day, and one keyword's or page's days by name.
- **Several companies**: workspaces kept apart by row-level security, with a switcher, a team and invitations.

What isn't there yet is listed in [section 8 of the spec](docs/00-product.md#8-planned).

## Running it

```bash
pnpm install
cp .env.example .env.local   # database, auth, your address in OWLSEEN_ADMINS, a sealing key
pnpm db:migrate
pnpm dev
```

Then connect an account under Settings, and choose your sites. `pnpm test` runs on an in-process Postgres.

**Figures only arrive if something calls `GET /api/cron/sync`** with `Authorization: Bearer $CRON_SECRET`. One call gets 270 seconds and leaves the rest for the next, so call it several times each morning: [the daily read](docs/01-daily-read.md) works out how many. `vercel.json` does that six times, which needs Vercel's Pro plan: Hobby allows cron jobs once a day and refuses to deploy this one. On Hobby or elsewhere, remove `crons` and use any scheduler.

**Run the app as the role that owns the tables**, the one that ran the migration: [section 6 of the spec](docs/00-product.md#6-storing) says what row-level security covers, how scoping works, and what a self-hosted database needs.

## License

AGPL-3.0-only.
