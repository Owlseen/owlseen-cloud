import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { symmetricDecrypt } from "better-auth/crypto";
import { workspacesOf } from "@/application/workspaces";
import { createAuth } from "@/infrastructure/auth/server";
import type { Database } from "@/infrastructure/db/client";
import { account, user } from "@/infrastructure/db/schema/auth";
import type { Env } from "@/infrastructure/env";
import { createTestDatabase } from "./support/database";

vi.mock("server-only", () => ({}));
vi.mock("better-auth/next-js", () => ({ nextCookies: () => ({ id: "next-cookies" }) }));

const BASE = "http://localhost:3000";
const SECRET = "a".repeat(32);
const settings = { OWLSEEN_DATABASE_URL: "postgres://user:password@localhost/owlseen", BETTER_AUTH_URL: BASE, BETTER_AUTH_SECRET: SECRET, OWLSEEN_ADMINS: "founder@example.com", OWLSEEN_PASSWORD_SIGN_IN: false, RESEND_API_KEY: "key", OWLSEEN_MAIL_FROM: "Owlseen <contact@owlseen.test>", OIDC_NAME: "SSO" } as Env;

let db: Database;
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
/** What the provider puts in its id_token: the nonce the sign-in asked for, signed for real. */
const round = { nonce: undefined as string | undefined };
const signedToken = (claims: Record<string, unknown>) => {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${part({ alg: "RS256", kid: "k1" })}.${part({ ...claims, ...(round.nonce ? { nonce: round.nonce } : {}) })}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(keys.privateKey).toString("base64url")}`;
};

/** Both providers' endpoints, faked: an access and a refresh token that can be looked for in the database. */
function providers(email: string, name = "Founder") {
  const claims = { sub: `sub-${email}`, email, email_verified: true, name, iss: "https://idp.example", aud: "client", exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) };
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.includes("resend.com")) return Response.json({ id: "mail" });
    if (url.endsWith("/.well-known/openid-configuration")) return Response.json({ issuer: "https://idp.example", authorization_endpoint: "https://idp.example/authorize", token_endpoint: "https://idp.example/token", userinfo_endpoint: "https://idp.example/userinfo", jwks_uri: "https://idp.example/jwks" });
    if (url.includes("oauth2.googleapis.com/token") || url === "https://idp.example/token") return Response.json({ access_token: "PLAIN-ACCESS-TOKEN", refresh_token: "PLAIN-REFRESH-TOKEN", id_token: signedToken(claims), token_type: "Bearer", expires_in: 3600 });
    if (url.includes("idp.example/userinfo")) return Response.json(claims);
    if (url.includes("idp.example/jwks")) return Response.json({ keys: [publicJwk] });
    if (url.includes("googleapis.com/certs") || url.includes("oauth2/v3/certs")) return Response.json({ keys: [] });
    throw new Error(`Unexpected ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;
}

const cookiesOf = (response: Response) => response.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");

async function signIn(auth: ReturnType<typeof createAuth>, provider: string) {
  const started = await auth.handler(new Request(`${BASE}/api/auth/sign-in/social`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ provider, callbackURL: "/overview" }) }));
  const answer = (await started.json()) as { url?: string; message?: string };
  if (!answer.url) throw new Error(`No address to go to: ${started.status} ${answer.message}`);
  const state = new URL(answer.url).searchParams.get("state") as string;
  round.nonce = new URL(answer.url).searchParams.get("nonce") ?? undefined;
  const back = await auth.handler(new Request(`${BASE}/api/auth/callback/${provider}?code=a-code&state=${encodeURIComponent(state)}`, { headers: { cookie: cookiesOf(started), origin: BASE } }));
  return { status: back.status, location: back.headers.get("location"), cookies: cookiesOf(back) };
}

beforeAll(async () => {
  vi.stubEnv("OWLSEEN_ADMINS", settings.OWLSEEN_ADMINS);
  vi.stubEnv("OWLSEEN_DATABASE_URL", settings.OWLSEEN_DATABASE_URL);
  vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
  vi.stubEnv("BETTER_AUTH_URL", BASE);
  db = await createTestDatabase();
}, 400_000);
afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
beforeEach(async () => {
  await db.delete(user);
});

describe("sealed sign-in tokens", () => {
  for (const [provider, extra] of [
    ["google", { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret" }],
    ["oidc", { OIDC_ISSUER: "https://idp.example", OIDC_CLIENT_ID: "client", OIDC_CLIENT_SECRET: "secret" }],
  ] as const) {
    it(`${provider}: signs in, seals the tokens, signs in again, and the session works`, async () => {
      vi.stubGlobal("fetch", providers("founder@example.com"));
      const auth = createAuth(db, { ...settings, ...extra });
      const first = await signIn(auth, provider);
      expect(first.location).toContain("/overview");
      const [row] = await db.select().from(account).where((await import("drizzle-orm")).eq(account.providerId, provider));
      expect(row.accessToken).not.toBe("PLAIN-ACCESS-TOKEN");
      expect(row.refreshToken).not.toBe("PLAIN-REFRESH-TOKEN");
      expect(await symmetricDecrypt({ key: SECRET, data: row.accessToken as string })).toBe("PLAIN-ACCESS-TOKEN");
      const session = await auth.api.getSession({ headers: new Headers({ cookie: first.cookies }) });
      expect(session?.user.email).toBe("founder@example.com");
      const again = await signIn(auth, provider);
      expect(again.location).toContain("/overview");
      expect(await workspacesOf(db, session?.user.id as string)).toEqual([]);
    });
  }
});

describe("an assistant's whole road to consent", () => {
  const verifier = "a-verifier-that-is-long-enough-for-pkce-and-then-some-more";
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  it("brings the redirect address to the consent page, and tampering with it fails the approval", async () => {
    vi.stubGlobal("fetch", providers("founder@example.com"));
    const auth = createAuth(db, { ...settings, GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret" });
    const { cookies } = await signIn(auth, "google");
    const registered = await auth.handler(new Request(`${BASE}/api/auth/oauth2/register`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ client_name: "Claude", client_uri: "https://claude.ai", redirect_uris: ["https://evil.example/callback"], token_endpoint_auth_method: "none" }) }));
    const { client_id: clientId } = (await registered.json()) as { client_id: string };
    const authorize = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://evil.example/callback", code_challenge: challenge, code_challenge_method: "S256", scope: "openid offline_access", state: "s", resource: `${BASE}/api/mcp` });
    const answer = await auth.handler(new Request(`${BASE}/api/auth/oauth2/authorize?${authorize}`, { headers: { cookie: cookies, origin: BASE } }));
    const to = answer.headers.get("location") ?? "";
    const query = new URL(to, BASE).searchParams;
    expect(new URL(to, BASE).pathname).toBe("/consent");
    expect(query.get("redirect_uri")).toBe("https://evil.example/callback");
    const signed = new URL(to, BASE).search.slice(1);
    const faked = signed.replace(encodeURIComponent("https://evil.example/callback"), encodeURIComponent("https://claude.ai/callback"));
    expect(faked).not.toBe(signed);
    const consent = (oauthQuery: string) => auth.handler(new Request(`${BASE}/api/auth/oauth2/consent`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie: cookies }, body: JSON.stringify({ accept: true, oauth_query: oauthQuery }) }));
    const tampered = await consent(faked);
    expect(tampered.status).toBeGreaterThanOrEqual(400);
    const honest = await consent(signed);
    const honestBody = (await honest.json()) as { url?: string; redirect_uri?: string };
    expect(honestBody.url ?? honestBody.redirect_uri).toContain("https://evil.example/callback");
  });
});
