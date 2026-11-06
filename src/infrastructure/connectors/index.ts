import type { ConnectorKind } from "@/domain/connectors";
import type { Adapter } from "./adapter";
import { bingAdapter } from "./bing";
import { googleAdapter } from "./google";

const adapters: Record<ConnectorKind, Adapter> = { google: googleAdapter, bing: bingAdapter };

/** The adapter that talks to a connector's service. */
export const adapterOf = (kind: ConnectorKind): Adapter => adapters[kind];
