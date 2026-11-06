import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConsentRequest, hostOf } from "@/app/consent/request";
import { createAuth, type Auth } from "@/infrastructure/auth/server";
import type { Database } from "@/infrastructure/db/client";
import type { Env } from "@/infrastructure/env";
import { createTestDatabase } from "./support/database";
import { fakeFetch } from "./support/fetch";

vi.mock("server-only", () => ({}));
vi.mock("better-auth/next-js", () => ({ nextCookies: () => ({ id: "next-cookies" }) }));

const BASE = "http://localhost:3000";
const settings = { OWLSEEN_DATABASE_URL: "postgres://user:password@localhost/owlseen", BETTER_AUTH_URL: BASE, BETTER_AUTH_SECRET: "a".repeat(32), OWLSEEN_ADMINS: "founder@example.com", OWLSEEN_PASSWORD_SIGN_IN: true, RESEND_API_KEY: "key", OWLSEEN_MAIL_FROM: "Owlseen <contact@owlseen.test>", OIDC_NAME: "SSO" } as Env;

let db: Database;
let auth: Auth;
beforeAll(async () => {
  vi.stubEnv("OWLSEEN_ADMINS", settings.OWLSEEN_ADMINS);
  vi.stubEnv("OWLSEEN_DATABASE_URL", settings.OWLSEEN_DATABASE_URL);
  vi.stubEnv("BETTER_AUTH_SECRET", settings.BETTER_AUTH_SECRET);
  vi.stubEnv("BETTER_AUTH_URL", BASE);
  vi.stubGlobal("fetch", fakeFetch([{ match: "POST https://api.resend.com/emails", json: { id: "mail" } }]).fetch);
  db = await createTestDatabase();
  auth = createAuth(db, settings);
}, 400_000);
afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const post = (path: string, body: unknown, type = "application/json") => auth.handler(new Request(`${BASE}/api/auth${path}`, { method: "POST", headers: { "content-type": type, origin: BASE }, body: typeof body === "string" ? body : JSON.stringify(body) }));

describe("consent", () => {
  it("anyone can still register as 'Claude', with claude.ai as its address and a redirect of its own", async () => {
    const response = await post("/oauth2/register", { client_name: "Claude", client_uri: "https://claude.ai", redirect_uris: ["https://evil.example/callback"], token_endpoint_auth_method: "none" });
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBeLessThan(300);
    expect(body.client_name).toBe("Claude");
    expect(body.redirect_uris).toEqual(["https://evil.example/callback"]);
  });

  it("so what a member sees says the name proves nothing, where they'd be sent back, and what it can do", () => {
    const page = renderToStaticMarkup(<ConsentRequest asker={{ name: "Claude", website: "https://claude.ai", sentBackTo: hostOf("https://evil.example/callback") }} workspaces={["Acme"]} />);
    expect(page).toContain("An app calling itself “Claude”");
    expect(page).not.toMatch(/<h1[^>]*>Claude is/);
    expect(page).toContain("that name proves nothing");
    expect(page).toContain("claude.ai");
    expect(page).toContain("evil.example");
    expect(page).toContain("make and revoke API keys");
  });

  it("says so when the address it would be sent back to can't be read", () => {
    expect(hostOf("not an address")).toBeNull();
    expect(hostOf(undefined)).toBeNull();
    const page = renderToStaticMarkup(<ConsentRequest asker={{ sentBackTo: null }} workspaces={["Acme", "Northwind"]} />);
    expect(page).toContain("An app is asking");
    expect(page).toContain("refuse this");
    expect(page).toContain("in all your workspaces, Acme and Northwind");
  });

  it("gives a client registered with no sign-in no way to act without a member", async () => {
    const made = await post("/oauth2/register", { client_name: "Script", redirect_uris: ["https://evil.example/callback"], token_endpoint_auth_method: "client_secret_post", grant_types: ["client_credentials"], response_types: [] });
    expect(made.status).toBe(400);
    expect(((await made.json()) as { error_description?: string }).error_description).toContain("client_credentials");
  });
});

describe("who may be told what", () => {
  it("gives a stranger and an admin the same answer to a password sign-up", async () => {
    const stranger = await post("/sign-up/email", { email: "nobody@example.com", password: "correct horse battery", name: "X" });
    const admin = await post("/sign-up/email", { email: "founder@example.com", password: "correct horse battery", name: "X" });
    expect(stranger.status).toBe(admin.status);
    const [shapeOf] = [(body: { user?: object }) => Object.keys(body.user ?? {}).sort()];
    expect(shapeOf((await stranger.json()) as { user?: object })).toEqual(shapeOf((await admin.json()) as { user?: object }));
  });
});

describe("the tokens a sign-in provider hands over", () => {
  it("are sealed at rest", () => {
    expect(auth.options.account?.encryptOAuthTokens).toBe(true);
  });
});
