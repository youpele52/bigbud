import type { Effect } from "effect";
import { Data, ServiceMap } from "effect";

import type {
  RemoteAgentResourceCleanupIdentity,
  RemoteAgentResourceCleanupOutcome,
  RemoteAgentResourceCleanupRequest,
} from "../../remote-agent/remoteAgentProtocol.resourceCleanup.ts";

export const DIRECT_CLEANUP_RESOURCE_KINDS = [
  "attachment",
  "provider-log",
  "terminal-history",
  "project-memory",
  "project-notes",
  "project-kanban",
] as const;
export type DirectCleanupResourceKind = (typeof DIRECT_CLEANUP_RESOURCE_KINDS)[number];

export interface DirectCleanupResource {
  readonly resourceId: string;
  readonly kind: DirectCleanupResourceKind;
  readonly root: string;
  readonly relativePath: string;
  readonly quarantineName: string;
  readonly identity?: RemoteAgentResourceCleanupIdentity;
  readonly rootIdentity: RemoteAgentResourceCleanupIdentity;
  readonly parentIdentity: RemoteAgentResourceCleanupIdentity;
}

export interface DirectCleanupResult {
  readonly resourceId: string;
  readonly outcome: RemoteAgentResourceCleanupOutcome;
  readonly errorCode: string;
}

export interface PreparedDirectResourceCleanupExecutor {
  readonly identity: {
    readonly buildVersion: string;
    readonly buildDigest: string;
    readonly protocolMajor: number;
    readonly protocolMinor: number;
  };
  readonly assertAlive: () => Promise<void>;
  readonly execute: (input: {
    readonly request: RemoteAgentResourceCleanupRequest;
    readonly encodedRequest: Uint8Array;
    readonly resources: ReadonlyArray<DirectCleanupResource>;
    readonly signal?: AbortSignal;
  }) => Promise<ReadonlyArray<DirectCleanupResult>>;
  readonly close: () => void;
  readonly shutdown: () => Promise<void>;
}

export interface DirectResourceCleanupExecutorShape {
  readonly prepare: () => Effect.Effect<
    PreparedDirectResourceCleanupExecutor,
    DirectResourceCleanupExecutorError
  >;
}

export class DirectResourceCleanupExecutorError extends Data.TaggedError(
  "DirectResourceCleanupExecutorError",
)<{ readonly detail: string; readonly cause?: unknown }> {}

export class DirectResourceCleanupExecutor extends ServiceMap.Service<
  DirectResourceCleanupExecutor,
  DirectResourceCleanupExecutorShape
>()("bigbud/deletion/Services/DirectResourceCleanupExecutor") {}
