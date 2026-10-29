/**
 * ProcessLedger - durable record of long-lived provider children (ACP agents, managed OpenCode servers) that
 * would outlive a crashed backend.
 *
 * ACP agents run in their own process group and do not exit on stdin EOF, so when the backend dies
 * without running its finalizers (V8 OOM, SIGKILL) nothing stops them. Each tracked child gets a
 * record under `<stateDir>/process-ledger/`; the next backend that holds the state directory lock
 * kills the children of provably dead owners whose identity still matches exactly.
 *
 * @module ProcessLedger
 */
import { Effect, ServiceMap } from "effect";

import type { ProcessLedgerKillMode } from "../ProcessLedger.record.ts";

export interface ProcessLedgerTrackInput {
  readonly pid: number;
  /** The spawned command and argv, as passed to spawn. */
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly kill: ProcessLedgerKillMode;
  /** Diagnostic label, such as `acp-agent` or `opencode-server`. */
  readonly label: string;
}

export interface ProcessLedgerTicket {
  /** Removes the record once the child is gone; a still-running child keeps it. Never fails. */
  readonly release: Effect.Effect<void>;
}

export interface ProcessLedgerShape {
  /**
   * Records a live child. Never fails: an unprovable identity (Windows, child already gone) or a
   * write error yields a no-op ticket, because tracking must never break a spawn.
   */
  readonly track: (input: ProcessLedgerTrackInput) => Effect.Effect<ProcessLedgerTicket>;
}

export const NOOP_PROCESS_LEDGER_TICKET: ProcessLedgerTicket = { release: Effect.void };

export class ProcessLedger extends ServiceMap.Service<ProcessLedger, ProcessLedgerShape>()(
  "bigbud/process-ledger/ProcessLedger",
) {}
