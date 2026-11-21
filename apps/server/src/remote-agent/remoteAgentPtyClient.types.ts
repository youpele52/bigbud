import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import {
  REMOTE_AGENT_LIFECYCLE_UNSUPPORTED,
  REMOTE_AGENT_PTY_LIMIT_REACHED,
  type RemoteAgentPtyCreateLimitFields,
} from "./remoteAgentProtocol.ptyLifecycle.ts";

export interface RemoteAgentPtyProcessLike {
  readonly pid: number;
  /** Only explicit agent evidence is exposed. Undefined remains unknown. */
  readonly launchStatus?: "unconfirmed" | undefined;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): () => void;
  onExit(callback: (event: { exitCode: number; signal: number | null }) => void): () => void;
  onError?(callback: (error: Error) => void): () => void;
}

export type RemoteAgentPtyInputStage = "allocation" | "request" | "acknowledgement";

export class RemoteAgentPtyError extends Error {
  readonly _tag = "RemoteAgentPtyError";
  readonly inputStage: RemoteAgentPtyInputStage | undefined;

  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions & { inputStage?: RemoteAgentPtyInputStage },
  ) {
    super(message, options);
    this.name = "RemoteAgentPtyError";
    this.inputStage = options?.inputStage;
  }
}

/** `PTY_LIMIT_REACHED`: nothing was created; the host names a candidate to evict and retry. */
export class RemoteAgentPtyLimitError extends RemoteAgentPtyError {
  readonly limit: number | undefined;
  readonly liveCount: number | undefined;
  readonly evictionCandidatePtyId: string | undefined;

  constructor(message: string, fields: RemoteAgentPtyCreateLimitFields) {
    super(REMOTE_AGENT_PTY_LIMIT_REACHED, message || "The terminal limit is reached.");
    this.limit = fields.limit;
    this.liveCount = fields.liveCount;
    this.evictionCandidatePtyId = fields.evictionCandidatePtyId || undefined;
  }
}

/** True for a host that refused, or cannot serve, a protocol 1.9 lifecycle request. */
export function isRemoteAgentLifecycleUnsupported(error: unknown): boolean {
  return error instanceof RemoteAgentPtyError && error.code === REMOTE_AGENT_LIFECYCLE_UNSUPPORTED;
}

export interface RemoteAgentPtyDurability {
  allocated(sequence: number, bytes: Uint8Array): Promise<void>;
  acknowledged(sequence: number): Promise<void>;
  output(sequence: number): Promise<void>;
  reconcile?(
    connection: RemoteAgentConnection,
    signal: AbortSignal,
  ): Promise<RemoteAgentPtyInputState>;
}

export interface RemoteAgentPtyInputState {
  nextSequence: number;
  resolvedSequence: number;
  writerUsable: boolean;
}

export type RemoteAgentPtyExitListener = Parameters<RemoteAgentPtyProcessLike["onExit"]>[0];
