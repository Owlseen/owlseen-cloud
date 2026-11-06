import { asc, eq, inArray } from "drizzle-orm";
import { managesSettings, NOT_A_MANAGER_OF_SETTINGS } from "@/domain/team";
import type { Tried } from "@/domain/tried";
import type { Database } from "@/infrastructure/db/client";
import { site, siteGroup, siteGroupMember } from "@/infrastructure/db/schema/search";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { isUuid } from "./sites";
import { roleIn } from "./team";

export interface SiteGroup {
  id: string;
  name: string;
  siteIds: string[];
}

const LONGEST_NAME = 80;
const CHOOSE_A_SITE = "Choose at least one site.";

/** A workspace's groups, each with its sites. */
export function siteGroupsOf(db: Database, workspaceId: string): Promise<SiteGroup[]> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [groups, members] = [await tx.select({ id: siteGroup.id, name: siteGroup.name }).from(siteGroup).orderBy(asc(siteGroup.name)), await tx.select().from(siteGroupMember)];
    return groups.map((group) => ({ ...group, siteIds: members.filter(({ groupId }) => groupId === group.id).map(({ siteId }) => siteId) }));
  });
}

/** A group, or the sites in it replaced when one has this name already. Sites are looked up first, as a foreign key doesn't go through row-level security and would take another workspace's. */
export async function saveSiteGroup(db: Database, workspaceId: string, userId: string, name: string, siteIds: readonly string[]): Promise<Tried> {
  if (!managesSettings(await roleIn(db, workspaceId, userId))) return { ok: false, error: NOT_A_MANAGER_OF_SETTINGS };
  const named = name.trim().slice(0, LONGEST_NAME);
  if (!named) return { ok: false, error: "Give this group a name." };
  const chosen = [...new Set(siteIds)].filter(isUuid);
  return withWorkspace(db, workspaceId, async (tx) => {
    const found = chosen.length === 0 ? [] : await tx.select({ id: site.id }).from(site).where(inArray(site.id, chosen));
    if (found.length === 0) return { ok: false, error: CHOOSE_A_SITE };
    const [group] = await tx.insert(siteGroup).values({ name: named }).onConflictDoUpdate({ target: [siteGroup.workspaceId, siteGroup.name], set: { name: named } }).returning({ id: siteGroup.id });
    await tx.delete(siteGroupMember).where(eq(siteGroupMember.groupId, group.id));
    await tx.insert(siteGroupMember).values(found.map(({ id }) => ({ groupId: group.id, siteId: id })));
    return { ok: true, said: `Saved ${named}, with ${found.length} ${found.length === 1 ? "site" : "sites"}.` };
  });
}

/** Removes a group, not its sites. */
export async function removeSiteGroup(db: Database, workspaceId: string, userId: string, groupId: string): Promise<Tried> {
  if (!managesSettings(await roleIn(db, workspaceId, userId))) return { ok: false, error: NOT_A_MANAGER_OF_SETTINGS };
  if (!isUuid(groupId)) return { ok: false, error: "There’s no such group here." };
  const removed = await withWorkspace(db, workspaceId, (tx) => tx.delete(siteGroup).where(eq(siteGroup.id, groupId)).returning({ name: siteGroup.name }));
  return removed.length > 0 ? { ok: true, said: `Removed ${removed[0].name}. Its sites stay.` } : { ok: false, error: "There’s no such group here." };
}
