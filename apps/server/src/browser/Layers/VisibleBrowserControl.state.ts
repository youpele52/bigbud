import type {
  BrowserResult,
  ThreadId,
  TurnId,
  VisibleBrowserCommand,
  VisibleBrowserRendererId,
} from "@bigbud/contracts";
import type { Deferred } from "effect";

import type { VisibleBrowserControlError } from "../Services/VisibleBrowserControl.ts";

export interface Lease {
  readonly leaseId: string;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly rendererId: VisibleBrowserRendererId;
  readonly openedByAgent: boolean;
  tabId: string | null;
}

export interface PendingCommand {
  readonly command: VisibleBrowserCommand;
  readonly deferred: Deferred.Deferred<BrowserResult, VisibleBrowserControlError>;
}

export interface VisibleBrowserState {
  readonly renderers: ReadonlyArray<VisibleBrowserRendererId>;
  readonly leases: ReadonlyMap<string, Lease>;
  readonly pending: ReadonlyMap<string, PendingCommand>;
  readonly releases: ReadonlyMap<string, VisibleBrowserCommand>;
  readonly revokedTabs: ReadonlyMap<string, Pick<Lease, "threadId" | "turnId">>;
  readonly createdTabs: ReadonlyMap<string, { readonly rendererId: VisibleBrowserRendererId }>;
}

export interface ReleasedLeases {
  readonly leases: ReadonlyArray<Lease>;
  readonly pending: ReadonlyArray<PendingCommand>;
  readonly releases: ReadonlyArray<VisibleBrowserCommand>;
}

export function makeVisibleBrowserState(): VisibleBrowserState {
  return {
    renderers: [],
    leases: new Map(),
    pending: new Map(),
    releases: new Map(),
    revokedTabs: new Map(),
    createdTabs: new Map(),
  };
}

export function removeRenderer(
  renderers: ReadonlyArray<VisibleBrowserRendererId>,
  rendererId: VisibleBrowserRendererId,
) {
  return renderers.filter((candidate) => candidate !== rendererId);
}
