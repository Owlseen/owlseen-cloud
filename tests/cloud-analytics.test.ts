import { describe, expect, it } from "vitest";
import { anonymizeAppUrl } from "@/components/cloud/cloud-analytics";
import { isCloudService } from "@/components/cloud/cloud-service";

describe("app.owlseen.com analytics", () => {
  it("replaces ids, tokens and dynamic segments, and drops the query string", () => {
    expect(anonymizeAppUrl("https://app.owlseen.com/")).toBe("https://app.owlseen.com/");
    expect(anonymizeAppUrl("https://app.owlseen.com/overview?site=acme.example&range=28d")).toBe("https://app.owlseen.com/overview");
    expect(anonymizeAppUrl("https://app.owlseen.com/pages?site=acme.example#top")).toBe("https://app.owlseen.com/pages");
    expect(anonymizeAppUrl("https://app.owlseen.com/connections/search-console")).toBe("https://app.owlseen.com/connections/[kind]");
    expect(anonymizeAppUrl("https://app.owlseen.com/join/s3cr3t-invite")).toBe("https://app.owlseen.com/join/[token]");
    expect(anonymizeAppUrl("https://app.owlseen.com/workspace/w_42")).toBe("https://app.owlseen.com/workspace/[workspace]");
    expect(anonymizeAppUrl("https://app.owlseen.com/reset-password?token=secret")).toBe("https://app.owlseen.com/reset-password");
    expect(anonymizeAppUrl("https://app.owlseen.com/sites/acme.example")).toBe("https://app.owlseen.com/sites/[id]");
  });

  it("runs only on the hosted service, never on a copy or a self-hosted instance", () => {
    expect(isCloudService({ VERCEL_GIT_REPO_OWNER: "Owlseen", VERCEL_GIT_REPO_SLUG: "owlseen-cloud" })).toBe(true);
    expect(isCloudService({ VERCEL_GIT_REPO_OWNER: "FAKGR0UP", VERCEL_GIT_REPO_SLUG: "owlseen-instance" })).toBe(false);
    expect(isCloudService({})).toBe(false);
  });
});
