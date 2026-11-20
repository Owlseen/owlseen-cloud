/**
 * True only for the hosted service, app.owlseen.com: a Vercel build of Owlseen/owlseen-cloud
 * (production and its previews). A copy of this repository deployed from
 * another repository, and a self-hosted instance, run without analytics.
 */
export function isCloudService(env: Record<string, string | undefined> = process.env): boolean {
  return env.VERCEL_GIT_REPO_OWNER?.toLowerCase() === "owlseen" && env.VERCEL_GIT_REPO_SLUG === "owlseen-cloud";
}
