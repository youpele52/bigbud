import { createHash } from "node:crypto";

export interface RemoteAgentProcessRequestDigestInput {
  readonly executionTargetId: string;
  readonly cwd: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly environment: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly truncateOutputAtMaxBytes?: boolean;
  readonly stdin?: string;
}

export function remoteAgentProcessRequestDigest(
  input: RemoteAgentProcessRequestDigestInput,
): Uint8Array {
  const hash = createHash("sha256");
  hash.update(input.executionTargetId);
  hash.update("\0");
  hash.update(input.cwd);
  hash.update("\0");
  hash.update(input.command);
  hash.update("\0");
  hash.update(JSON.stringify(input.args));
  hash.update("\0");
  hash.update(JSON.stringify(input.environment));
  hash.update("\0");
  hash.update(String(input.timeoutMs));
  hash.update("\0");
  hash.update(String(input.maxOutputBytes));
  hash.update("\0");
  hash.update(String(input.truncateOutputAtMaxBytes ?? false));
  hash.update("\0");
  hash.update(input.stdin ?? "");
  return hash.digest();
}

export function remoteAgentWorkspaceHandle(input: {
  readonly executionTargetId: string;
  readonly cwd: string;
}): string {
  return `workspace-${createHash("sha256")
    .update(`${input.executionTargetId}\0${input.cwd}`)
    .digest("hex")
    .slice(0, 32)}`;
}
