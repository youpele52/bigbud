import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";

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
