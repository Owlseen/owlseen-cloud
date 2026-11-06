import { reportedUpTo } from "@/application/search-columns";
import { siteGroupsOf } from "@/application/site-groups";
import { sitesOf } from "@/application/sites";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { chosenIn, type Query } from "./reading";

/** Who is reading and what they can choose from, which every page that reads figures starts with. */
export async function readingContext(query: Query) {
  const seat = await currentSeat();
  const [sites, groups] = await Promise.all([sitesOf(db(), seat.workspaceId), siteGroupsOf(db(), seat.workspaceId)]);
  const reported = await withWorkspace(db(), seat.workspaceId, reportedUpTo);
  return { seat, sites, groups, chosen: chosenIn(sites, groups, query), reported };
}
