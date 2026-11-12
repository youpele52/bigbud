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

export class RemoteAgentPtyError extends Error {
  readonly _tag = "RemoteAgentPtyError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RemoteAgentPtyError";
  }
}
