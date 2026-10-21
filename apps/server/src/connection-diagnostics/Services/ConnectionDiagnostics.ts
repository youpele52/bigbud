import type {
  OrchestrationDeliverySessionEndReason,
  ServerEventLoopWindow,
  ServerStalledPayload,
  ServerWsConnectionDiagnosticsSnapshot,
  WsConnectionDiagnosticsReport,
  WsConnectionDiagnosticsReportEntry,
} from "@bigbud/contracts/server/connectionDiagnostics.ts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface DeliverySessionEndedInput {
  readonly consumerId: string;
  readonly reason: OrchestrationDeliverySessionEndReason;
  readonly durationMs: number;
}

export interface SuspectedSystemSleepInput {
  readonly endedAtMs: number;
  readonly durationMs: number;
}

/**
 * Bounded, in-memory record of connection transitions: renderer reports and
 * server-side events (stalls, delivery session ends). Every record is also
 * logged and traced under a stable span name so it survives a restart in the
 * trace file even though the rings do not.
 */
export interface ConnectionDiagnosticsShape {
  readonly recordReport: (
    report: WsConnectionDiagnosticsReport,
  ) => Effect.Effect<WsConnectionDiagnosticsReportEntry>;
  readonly recordStall: (payload: ServerStalledPayload) => Effect.Effect<void>;
  /** Records a gap classified as system sleep; it is not published as a stall. */
  readonly recordSuspectedSystemSleep: (input: SuspectedSystemSleepInput) => Effect.Effect<void>;
  readonly recordDeliverySessionEnded: (input: DeliverySessionEndedInput) => Effect.Effect<void>;
  readonly recordEventLoopWindow: (window: ServerEventLoopWindow) => Effect.Effect<void>;
  readonly snapshot: (limit?: number) => Effect.Effect<ServerWsConnectionDiagnosticsSnapshot>;
  /**
   * Flipped by the first server finalizer to run, before any route closes, so
   * streams torn down by the shutdown can attribute their end to it.
   */
  readonly markServerShuttingDown: Effect.Effect<void>;
  readonly isServerShuttingDown: () => boolean;
}

export class ConnectionDiagnostics extends ServiceMap.Service<
  ConnectionDiagnostics,
  ConnectionDiagnosticsShape
>()("bigbud/connection-diagnostics/Services/ConnectionDiagnostics") {}
