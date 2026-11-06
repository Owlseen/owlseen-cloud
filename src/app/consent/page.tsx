import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { workspacesOf, type MemberWorkspace } from "@/application/workspaces";
import { Loading, Standalone } from "@/components/shell";
import { Card } from "@/components/ui";
import { auth } from "@/infrastructure/auth/server";
import { currentMember } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { ConsentButtons } from "./consent-buttons";
import { ConsentRequest, hostOf } from "./request";

export const metadata: Metadata = { title: "Allow an assistant" };

/** An assistant acts inside a workspace: a new member names theirs first, then comes back here. */
async function requireWorkspaces(query: Record<string, string | string[] | undefined>): Promise<MemberWorkspace[]> {
  const member = await currentMember();
  if (!member) redirect("/sign-in");
  const workspaces = await workspacesOf(db(), member.userId);
  if (workspaces.length > 0) return workspaces;
  const here = new URLSearchParams(Object.entries(query).flatMap(([key, value]) => (typeof value === "string" ? [[key, value]] : [])));
  redirect(`/welcome?${new URLSearchParams({ next: `/consent?${here}` })}`);
}

/** The assistant asking, as it describes itself, and where approving it would send the member. */
async function Request({ searchParams }: { searchParams: PageProps<"/consent">["searchParams"] }) {
  const query = await searchParams;
  const workspaces = await requireWorkspaces(query);
  const { client_id: clientId, redirect_uri: redirectUri } = query;
  const client = typeof clientId === "string" ? await auth().api.getOAuthClientPublic({ query: { client_id: clientId }, headers: await headers() }).catch(() => null) : null;
  return (
    <Card className="mt-8 w-full max-w-md">
      <ConsentRequest asker={{ name: client?.client_name, website: client?.client_uri, sentBackTo: hostOf(typeof redirectUri === "string" ? redirectUri : undefined) }} workspaces={workspaces.map(({ name }) => name)} />
      <div className="mt-6">
        <ConsentButtons />
      </div>
    </Card>
  );
}

/** Where a member approves or refuses an assistant. */
export default function ConsentPage({ searchParams }: PageProps<"/consent">) {
  return (
    <Standalone>
      <Suspense fallback={<Loading />}>
        <Request searchParams={searchParams} />
      </Suspense>
    </Standalone>
  );
}
