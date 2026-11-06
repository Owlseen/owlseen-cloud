import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { sitesOf } from "@/application/sites";
import { syncDueSites } from "@/application/sync";
import type { Database } from "@/infrastructure/db/client";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { connectGoogle, followSite, GOOGLE_TOKEN, googleProperty, NOW, testServices } from "./support/search";

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
}, 400_000);

describe("one long address", () => {
  it("doesn't stop a site's read for good", async () => {
    const seat = await createTestWorkspace(db);
    await connectGoogle(testServices(db).services, seat.workspaceId, seat.userId);
    await followSite(db, seat.workspaceId, "acme.example");
    const long = `https://acme.example/search?q=${randomBytes(4_000).toString("hex")}`;
    const answers = { pages: [{ keys: [long, "2026-11-01"], clicks: 1, impressions: 2, position: 3 }, { keys: ["https://acme.example/", "2026-11-01"], clicks: 5, impressions: 9, position: 2 }] };
    const { services } = testServices(db, [...googleProperty("sc-domain:acme.example", answers), GOOGLE_TOKEN]);
    const report = await syncDueSites(services, NOW.getTime() + 3_600_000);
    const [row] = await sitesOf(db, seat.workspaceId);
    expect(row.lastSyncError).toBeNull();
    expect(report).toMatchObject({ synced: 1 });
  });
});
