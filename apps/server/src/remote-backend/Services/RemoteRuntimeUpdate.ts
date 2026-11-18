import * as ServiceMap from "effect/ServiceMap";
import type * as Effect from "effect/Effect";
import type {
  RemoteRuntimeUpdateAffectedWork,
  RemoteRuntimeUpdateCancelInput,
  RemoteRuntimeUpdateConsentInput,
  RemoteRuntimeUpdateError,
  RemoteRuntimeUpdateOperation,
  RemoteRuntimeUpdateRequestInput,
  RemoteRuntimeUpdateRequestResult,
  RemoteRuntimeUpdateSource,
  RemoteRuntimeUpdateState,
  RemoteRuntimeUpdateStatus,
  RemoteRuntimeUpdateStatusInput,
} from "@bigbud/contracts/server/remoteBackendUpdate.ts";
import type { VerifiedBackendGraph } from "../backendGraph.ts";
import type { RuntimeArchiveStore } from "../runtimeArchive.store.ts";

/** A resolved, signed graph for the requested version (D5 source chosen by the integrator). */
export interface RuntimeUpdateGraph {
  /** The signed manifest; its version and digest name the archive slot. */
  readonly manifest: unknown;
  /**
   * Extracts the graph into the reserved, empty `graphRoot` and verifies it there with
   * `verifyBackendGraph`; the store revalidates that token before recording it.
   */
  readonly extract: (graphRoot: string, signal: AbortSignal) => Promise<VerifiedBackendGraph>;
}

export interface RuntimeUpdateGraphSource {
  readonly resolve: (
    input: { readonly version: string; readonly source: RemoteRuntimeUpdateSource },
    signal: AbortSignal,
  ) => Promise<RuntimeUpdateGraph>;
}

/**
 * WP-4D seam. `onStaged` runs after staging commits (still outside the lock), and `onResume`
 * runs at startup for a live operation past staging. Without it the operation stays `staged`.
 */
export interface RuntimeUpdateActivationSeam {
  readonly onStaged: (operation: RemoteRuntimeUpdateOperation) => Effect.Effect<void>;
  readonly onResume: (operation: RemoteRuntimeUpdateOperation) => Effect.Effect<void>;
}

export interface RemoteRuntimeUpdateDependencies {
  /** Opens the archive store; called only under the single-flight lock with its assertion. */
  readonly openStore: (checkpoint: () => Promise<void>) => Promise<RuntimeArchiveStore>;
  readonly graphSource: RuntimeUpdateGraphSource;
  /** Work an interruption would stop (turns, pending approvals...); never Rust terminals. */
  readonly affectedWork: (
    operation: RemoteRuntimeUpdateOperation,
  ) => Effect.Effect<ReadonlyArray<RemoteRuntimeUpdateAffectedWork>>;
  /** Backend instance ownership assertion, checked by every store checkpoint. */
  readonly assertOwner?: () => Promise<void>;
  readonly activation?: RuntimeUpdateActivationSeam;
  /** This runtime's version: a request for an older one is refused before anything is staged. */
  readonly runningVersion?: string;
}

type Result<A> = Effect.Effect<A, RemoteRuntimeUpdateError>;

export interface RemoteRuntimeUpdateShape {
  /** D10: create or join the single serialized operation. Never records interruption consent. */
  readonly request: (
    input: RemoteRuntimeUpdateRequestInput,
  ) => Result<RemoteRuntimeUpdateRequestResult>;
  readonly status: (input: RemoteRuntimeUpdateStatusInput) => Result<RemoteRuntimeUpdateStatus>;
  /** D9: operation- and affected-work-bound interruption consent. */
  readonly consent: (
    input: RemoteRuntimeUpdateConsentInput,
  ) => Result<RemoteRuntimeUpdateOperation>;
  /** Cancels before activation; releases the staged archive reservation. */
  readonly cancel: (input: RemoteRuntimeUpdateCancelInput) => Result<RemoteRuntimeUpdateOperation>;

  // WP-4D seam ----------------------------------------------------------------------------
  /** Runs `use` under the single-flight lock, with the store opened under that lock. */
  readonly withSingleFlight: <A, E, R>(
    use: (store: RuntimeArchiveStore, archiveKey: string | null) => Effect.Effect<A, E, R>,
    operationId: string,
  ) => Effect.Effect<A, E | RemoteRuntimeUpdateError, R>;
  /** Legal state-machine transition (see `RUNTIME_UPDATE_TRANSITIONS`). */
  readonly advance: (
    operationId: string,
    to: RemoteRuntimeUpdateState,
    failure?: string,
  ) => Result<RemoteRuntimeUpdateOperation>;
  /** Single use; call under `withSingleFlight` immediately before interrupting work. */
  readonly consumeInterruptionConsent: (
    operationId: string,
  ) => Result<RemoteRuntimeUpdateOperation>;
  /** Resolves once no staging is in flight (tests and 4D sequencing). */
  readonly awaitStaging: Effect.Effect<void>;
}

/** The serialized remote runtime update operation (M3 WP-4C). Remote backends only. */
export class RemoteRuntimeUpdate extends ServiceMap.Service<
  RemoteRuntimeUpdate,
  RemoteRuntimeUpdateShape
>()("bigbud/remote-backend/RemoteRuntimeUpdate") {}
