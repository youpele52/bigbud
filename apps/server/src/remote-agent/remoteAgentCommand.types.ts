/**
 * Local structural contract for a bounded remote-agent setup command.
 *
 * These modules used to import `RunSshCommandInput` from `ssh/sshProcess.ts`.
 * The owner migration deletes that module, so the shape they actually consume is
 * declared here instead. Callers may still pass the legacy SSH runner: it
 * satisfies this narrower contract.
 */
export interface RemoteAgentCommandRequest {
  readonly executionTargetId: string | null | undefined;
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
  readonly allowNonZeroExit?: boolean;
  readonly outputMode?: "error" | "truncate" | undefined;
  readonly stdin?: string;
  readonly stderrTailBytes?: number;
}

/** Runs one bounded setup command; results without exit metadata count as success. */
export type RemoteAgentCommandRunner = (input: RemoteAgentCommandRequest) => Promise<unknown>;
