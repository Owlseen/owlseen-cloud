import { bigint, boolean, date, foreignKey, index, integer, pgTable, primaryKey, real, text, timestamp, unique, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { Engine } from "@/domain/search";
import { createdAt, tenantIsolation, updatedAt, workspaceColumn } from "./shared";
import { workspace } from "./tenancy";

// ─── Sites ─────────────────────────────────────────────────────────────────

/** A website a workspace follows, and what it's called in each search engine it's connected to. */
export const site = pgTable(
  "site",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn().references(() => workspace.id, { onDelete: "cascade" }),
    /** Its domain, which is how a member knows it. */
    name: text().notNull(),
    /** Search Console's name for it: sc-domain:acme.example, or a URL. */
    googleProperty: text(),
    /** Bing's name for it: a URL. */
    bingSite: text(),
    lastSyncedAt: timestamp({ withTimezone: true }),
    /** Why the last sync didn't finish, or what it couldn't read, in the member's words. */
    lastSyncError: text(),
    /** The last read failed or didn't finish. Not the same as an error said above: a note about an engine nobody can read leaves the rest of a read that worked. */
    lastReadFailed: boolean().notNull().default(false),
    /** When each engine was last read to the end: where its next read starts from, and whether its silence means anything. */
    googleReadAt: timestamp({ withTimezone: true }),
    bingReadAt: timestamp({ withTimezone: true }),
    /** How far a read of Google's keywords and pages still under way has saved: the next run carries on from there. */
    keywordsReadThrough: date(),
    pagesReadThrough: date(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [unique().on(table.workspaceId, table.name), unique().on(table.id, table.workspaceId), tenantIsolation()],
).enableRLS();

/** Sites read together, the way a company thinks of them: a business, a language, a client. A site can be in several. */
export const siteGroup = pgTable(
  "site_group",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn().references(() => workspace.id, { onDelete: "cascade" }),
    name: text().notNull(),
    createdAt: createdAt(),
  },
  (table) => [unique().on(table.workspaceId, table.name), unique().on(table.id, table.workspaceId), tenantIsolation()],
).enableRLS();

// A foreign key doesn't go through row-level security, so a row could name another workspace's site
// or keyword without these: each reference includes the workspace, and only the row's own can match.

const siteColumn = () => uuid().notNull();

type InAWorkspace = { workspaceId: AnyPgColumn };

const ofItsSite = (table: InAWorkspace & { siteId: AnyPgColumn }, name: string) => foreignKey({ name, columns: [table.siteId, table.workspaceId], foreignColumns: [site.id, site.workspaceId] }).onDelete("cascade");

export const siteGroupMember = pgTable(
  "site_group_member",
  {
    workspaceId: workspaceColumn(),
    groupId: uuid().notNull(),
    siteId: siteColumn(),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.siteId] }),
    ofItsSite(table, "site_group_member_site_fk"),
    foreignKey({ name: "site_group_member_group_fk", columns: [table.groupId, table.workspaceId], foreignColumns: [siteGroup.id, siteGroup.workspaceId] }).onDelete("cascade"),
    tenantIsolation(),
  ],
).enableRLS();

// ─── A site's days ─────────────────────────────────────────────────────────
//
// Every screen reads these rather than asking an engine, so a chart costs the same whatever its
// period, spends no quota, and lets the database sleep. Days are as the engine reports them, and a
// recent day is read again until it settles. Typed columns, not JSON: a row a day per keyword is
// most of what's stored here. `engine` is text on purpose: comparing enums isn't leakproof, so
// behind row-level security Postgres wouldn't use an index on one.

export const searchDay = pgTable(
  "search_day",
  {
    workspaceId: workspaceColumn(),
    siteId: siteColumn(),
    day: date().notNull(),
    engine: text().$type<Engine>().notNull(),
    clicks: integer().notNull(),
    impressions: integer().notNull(),
    /** Average position that day, weighted by impressions. Null when the engine doesn't say. */
    position: real(),
  },
  (table) => [primaryKey({ columns: [table.siteId, table.day, table.engine] }), index().on(table.workspaceId, table.day), ofItsSite(table, "search_day_site_fk"), tenantIsolation()],
).enableRLS();

/** A keyword's or a page's id: big, as a year of reads of a large workspace is a lot of numbers. */
const nameId = () => bigint({ mode: "number" });

/** What people searched for, once per site: the words are long and repeat every day. */
export const keyword = pgTable(
  "keyword",
  {
    id: nameId().primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: workspaceColumn(),
    siteId: siteColumn(),
    text: text().notNull(),
  },
  (table) => [unique().on(table.siteId, table.text), unique().on(table.id, table.workspaceId), ofItsSite(table, "keyword_site_fk"), tenantIsolation()],
).enableRLS();

const ofItsKeyword = (table: InAWorkspace & { keywordId: AnyPgColumn }, name: string) => foreignKey({ name, columns: [table.keywordId, table.workspaceId], foreignColumns: [keyword.id, keyword.workspaceId] }).onDelete("cascade");

export const keywordDay = pgTable(
  "keyword_day",
  {
    workspaceId: workspaceColumn(),
    siteId: siteColumn(),
    day: date().notNull(),
    keywordId: nameId().notNull(),
    clicks: integer().notNull(),
    impressions: integer().notNull(),
    position: real().notNull(),
  },
  // The day before the keyword, so a period's keywords read that period; the other index is one keyword's history.
  (table) => [primaryKey({ columns: [table.siteId, table.day, table.keywordId] }), index().on(table.keywordId, table.day), ofItsSite(table, "keyword_day_site_fk"), ofItsKeyword(table, "keyword_day_keyword_fk"), tenantIsolation()],
).enableRLS();

/** A page that has shown up in search, once per site. */
export const page = pgTable(
  "page",
  {
    id: nameId().primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: workspaceColumn(),
    siteId: siteColumn(),
    url: text().notNull(),
    /** When its index status was last asked: those asked longest ago go first. */
    inspectedAt: timestamp({ withTimezone: true }),
  },
  (table) => [unique().on(table.siteId, table.url), unique().on(table.id, table.workspaceId), index().on(table.siteId, table.inspectedAt), ofItsSite(table, "page_site_fk"), tenantIsolation()],
).enableRLS();

const ofItsPage = (table: InAWorkspace & { pageId: AnyPgColumn }, name: string) => foreignKey({ name, columns: [table.pageId, table.workspaceId], foreignColumns: [page.id, page.workspaceId] }).onDelete("cascade");

export const pageDay = pgTable(
  "page_day",
  {
    workspaceId: workspaceColumn(),
    siteId: siteColumn(),
    day: date().notNull(),
    pageId: nameId().notNull(),
    clicks: integer().notNull(),
    impressions: integer().notNull(),
    position: real().notNull(),
  },
  (table) => [primaryKey({ columns: [table.siteId, table.day, table.pageId] }), index().on(table.pageId, table.day), ofItsSite(table, "page_day_site_fk"), ofItsPage(table, "page_day_page_fk"), tenantIsolation()],
).enableRLS();

// ─── What a member follows and what's checked ──────────────────────────────

export const trackedKeyword = pgTable(
  "tracked_keyword",
  {
    workspaceId: workspaceColumn(),
    siteId: siteColumn(),
    keywordId: nameId().notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.siteId, table.keywordId] }), ofItsSite(table, "tracked_keyword_site_fk"), ofItsKeyword(table, "tracked_keyword_keyword_fk"), tenantIsolation()],
).enableRLS();

/**
 * A page's index status on a day it was asked. The engine only says what's true now, so this is what
 * remembers a page dropping out.
 */
export const indexCheck = pgTable(
  "index_check",
  {
    workspaceId: workspaceColumn(),
    siteId: siteColumn(),
    pageId: nameId().notNull(),
    day: date().notNull(),
    /** PASS when it's indexed; the engine's other verdicts mean it isn't. */
    verdict: text().notNull(),
    /** The engine's own wording, such as "Crawled - currently not indexed". */
    coverage: text(),
    lastCrawlAt: timestamp({ withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.pageId, table.day] }), index().on(table.siteId, table.day), ofItsSite(table, "index_check_site_fk"), ofItsPage(table, "index_check_page_fk"), tenantIsolation()],
).enableRLS();

/** A sitemap an engine knows about for a site, as it last said. */
export const sitemap = pgTable(
  "sitemap",
  {
    workspaceId: workspaceColumn(),
    siteId: siteColumn(),
    engine: text().$type<Engine>().notNull(),
    url: text().notNull(),
    submittedAt: timestamp({ withTimezone: true }),
    lastReadAt: timestamp({ withTimezone: true }),
    errors: integer().notNull().default(0),
    warnings: integer().notNull().default(0),
    /** How many addresses it lists, as the engine counted them. */
    urls: integer().notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.siteId, table.engine, table.url] }), ofItsSite(table, "sitemap_site_fk"), tenantIsolation()],
).enableRLS();
