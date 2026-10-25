/**
 * PtyAdapter - Terminal PTY adapter service contract.
 *
 * Defines the process primitives required by terminal session management
 * without binding to a specific PTY implementation.
 *
 * @module PtyAdapter
 */
import { Effect, Schema, ServiceMap } from "effect";

/**
 * PtyError - Error type for PTY adapter operations.
 */
export class PtySpawnError extends Schema.TaggedErrorClass<PtySpawnError>()("PtySpawnError", {
  adapter: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface PtyExitEvent {
  exitCode: number;
  signal: number | null;
}

export interface PtyProcess {
  /** Attached to an existing process whose earlier output is not replayed by this adapter. */
  readonly recovered?: boolean;
  /** Explicit replacement must wait for definitive exit and durable ownership release. */
  readonly prepareRestart?: () => Promise<void>;
  readonly detach?: () => void;
  readonly pid: number;
  write(data: string): void;
  /**
   * Producer flow control: stop reading output so the child blocks on a full PTY buffer, then
   * resume. Optional; adapters without it are bounded by delivery overflow instead.
   */
  readonly pause?: () => void;
  readonly resume?: () => void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): () => void;
  onExit(callback: (event: PtyExitEvent) => void): () => void;
}

export interface PtySpawnInput {
  readonly ownerKey?: string;
  readonly recoverOnly?: boolean;
  shell: string;
  args?: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
  readonly executionTargetId?: string;
  readonly remoteCwd?: string;
}

/**
 * PtyAdapterShape - Service API for spawning and controlling PTY processes.
 */
export interface PtyAdapterShape {
  /**
   * Spawn a PTY process for a terminal session.
   */
  spawn(input: PtySpawnInput): Effect.Effect<PtyProcess, PtySpawnError>;
}

/**
 * PtyAdapter - Service tag for PTY process integration.
 */
export class PtyAdapter extends ServiceMap.Service<PtyAdapter, PtyAdapterShape>()(
  "t3/terminal/Services/PTY/PtyAdapter",
) {}
