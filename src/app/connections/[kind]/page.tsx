import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { connectionsOf, type ConnectionView } from "@/application/connections";
import { googleRedirectAddress } from "@/application/google-consent";
import { oneOf, type Query } from "@/components/reading";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { ConfirmButton, TryButton } from "@/components/try-button";
import { Card, Code, StatusDot } from "@/components/ui";
import { when } from "@/components/when";
import { CONNECTORS, connectorOf, type Connector } from "@/domain/connectors";
import { managesSettings } from "@/domain/team";
import { currentSeat } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";
import { checkAction, disconnectAction } from "../actions";
import { ConnectForm } from "./connect-form";

export function generateStaticParams() {
  return CONNECTORS.map((connector) => ({ kind: connector.kind }));
}

export async function generateMetadata({ params }: PageProps<"/connections/[kind]">): Promise<Metadata> {
  const { kind } = await params;
  return { title: connectorOf(kind)?.name ?? "Connection" };
}

/** What's still to do once the fields are saved: a member allows access at the service, and comes back. */
function Consent({ connection, connector, mayChange }: { connection: ConnectionView; connector: Connector; mayChange: boolean }) {
  if (!connector.consentCallback || !connection.awaitsConsent) return null;
  return (
    <div className="mt-4 space-y-2">
      <p className="text-sm text-alert">Saved, but nothing can be read until a Google account allows it.</p>
      {mayChange && (
        <a href={`/api/connections/google/start?connection=${connection.id}`} className="inline-flex rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover">
          Allow access with Google
        </a>
      )}
    </div>
  );
}

function Connection({ connection, connector, mayChange }: { connection: ConnectionView; connector: Connector; mayChange: boolean }) {
  return (
    <Card>
      <div className="flex min-w-0 items-center gap-3">
        <StatusDot status={connection.status} />
        <span className="min-w-0 flex-1 truncate font-medium">{connection.label}</span>
      </div>
      {connection.checkedAt && <p className="mt-1 text-xs text-muted-foreground">Checked {when(connection.checkedAt)}</p>}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <TryButton action={checkAction.bind(null, connector.kind, connection.id)} label="Check" busy="Checking…" />
        {mayChange && <ConfirmButton action={disconnectAction.bind(null, connector.kind, connection.id)} label="Disconnect" confirm="Confirm: forget this account and its keys" />}
      </div>
      {connection.lastError && <p className="mt-3 text-sm text-alert">{connection.lastError}</p>}
      <Consent connection={connection} connector={connector} mayChange={mayChange} />
    </Card>
  );
}

const HOSTING_WORDS = { EU: "the European Union", US: "the United States", "EU or US": "the European Union or the United States, depending on your account" };

async function Content({ params, searchParams }: { params: PageProps<"/connections/[kind]">["params"]; searchParams: Promise<Query> }) {
  const { kind } = await params;
  const query = await searchParams;
  const connector = connectorOf(kind);
  if (!connector) notFound();
  const seat = await currentSeat();
  const mine = (await connectionsOf(appServices(), seat.workspaceId)).filter((connection) => connection.kind === connector.kind);
  const mayChange = managesSettings(seat.role);
  return (
    <>
      <PageHeading title={connector.name}>{connector.summary}</PageHeading>
      <SettingsNav current="/connections" />
      <div className="max-w-3xl space-y-4">
        {oneOf(query, "said") && <p className="text-sm text-calm">{oneOf(query, "said")}</p>}
        {oneOf(query, "error") && <p className="text-sm text-alert">{oneOf(query, "error")}</p>}
        {mine.map((connection) => (
          <Connection key={connection.id} connection={connection} connector={connector} mayChange={mayChange} />
        ))}
        <Card>
          <h2 className="mb-4 font-semibold tracking-[-0.015em]">{mine.length > 0 ? "Connect again, with a new key" : "Connect"}</h2>
          <ol className="mb-5 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
            {connector.setup.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {connector.consentCallback && (
            <div className="mb-5">
              <p className="mb-1 text-sm text-muted-foreground">Its redirect address:</p>
              <Code>{googleRedirectAddress(appServices())}</Code>
            </div>
          )}
          {mayChange ? <ConnectForm kind={connector.kind} fields={connector.fields} /> : <p className="text-sm text-muted-foreground">Only owners and admins connect services.</p>}
          <p className="mt-5 text-xs text-muted-foreground">
            Data processed in {HOSTING_WORDS[connector.hosting]}.{" "}
            {connector.docs && (
              <a href={connector.docs} target="_blank" rel="noreferrer" className="text-link hover:underline">
                The service’s documentation
              </a>
            )}
          </p>
        </Card>
      </div>
    </>
  );
}

/** One service: the account connected, and how to connect it. */
export default function ConnectionPage({ params, searchParams }: PageProps<"/connections/[kind]">) {
  return (
    <Shell section="settings">
      <Suspense fallback={<Loading />}>
        <Content params={params} searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}
