import { ServiceMap } from "effect";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import type { ExecutionTargetId, ProviderKind } from "@bigbud/contracts";

export interface OpencodeServerHandle {
  /** The connected client ready to use. */
  readonly client: OpencodeClient;
  /** The URL the server is listening on. */
  readonly url: string;
  /** Monotonically increasing identity for the managed server instance. */
  readonly generation?: number;
  /** Release this handle. The warm shared server stops when the manager shuts down. */
  release(): void;
  /** Release and discard an unhealthy shared server so the next acquisition starts a fresh one. */
  invalidate(): void;
  /** Observes an unexpected loss of this server generation. */
  onInvalidated?(listener: () => void): () => void;
}

export interface OpencodeServerAcquireInput {
  readonly directory?: string;
  readonly executionTargetId?: ExecutionTargetId;
  readonly binaryPath?: string;
  readonly provider?: Extract<ProviderKind, "opencode" | "kilocode">;
}

export interface OpencodeServerManagerShape {
  /**
   * Acquire a handle to the shared OpenCode server.
   * Starts the server the first time; subsequent calls reuse the warm process.
   * Pass `directory` to bake a working directory into the created client (v2).
   * Call `handle.release()` when you no longer need it.
   */
  acquire(input?: OpencodeServerAcquireInput): Promise<OpencodeServerHandle>;
}

export class OpencodeServerManager extends ServiceMap.Service<
  OpencodeServerManager,
  OpencodeServerManagerShape
>()("t3/provider/Services/OpencodeServerManager") {}
