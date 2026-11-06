import { accessOfKey, bearerOf } from "@/application/api-keys";
import { figuresOf } from "@/application/figures";
import { isUuid } from "@/application/sites";
import { boundedDays, periodEndingAt } from "@/application/time-range";
import { appServices } from "@/infrastructure/services";

/** A workspace's figures, per site and per day, for an app holding one of its keys. Shape documented in docs/00-product.md. */
export async function GET(request: Request) {
  // The header first: a build prerenders this route, and has no environment to read for what follows.
  const key = bearerOf(request);
  const services = appServices();
  const access = await accessOfKey(services.db, key, "figures:read");
  if (access.status === "unknown") return Response.json({ error: "Missing or refused API key." }, { status: 401 });
  if (access.status === "forbidden") return Response.json({ error: "This key may not read figures." }, { status: 403 });
  const query = new URL(request.url).searchParams;
  const site = query.get("site") ?? undefined;
  if (site && !isUuid(site)) return Response.json({ error: "site is a site’s id." }, { status: 400 });
  const asked = Math.trunc(Number(query.get("page")));
  const page = Number.isSafeInteger(asked) && asked > 0 ? asked : 1;
  return Response.json(await figuresOf(services.db, access.workspaceId, periodEndingAt(services.now(), boundedDays(query.get("days"), 30)), site, page));
}
