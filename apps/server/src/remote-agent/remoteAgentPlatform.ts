import { runSshCommand } from "../ssh/sshProcess.ts";
import {
  resolveRemoteAgentTargetTriple,
  type RemoteAgentTargetTriple,
} from "./remoteAgentArtifact.ts";

export interface RemoteAgentPlatformInfo {
  readonly operatingSystem: string;
  readonly architecture: string;
  readonly targetTriple: RemoteAgentTargetTriple | null;
}

export class RemoteAgentPlatformProbeError extends Error {
  readonly _tag = "RemoteAgentPlatformProbeError";

  constructor(message: string) {
    super(message);
    this.name = "RemoteAgentPlatformProbeError";
  }
}

export function parseRemoteAgentPlatformProbe(output: string): RemoteAgentPlatformInfo {
  const [operatingSystem, architecture] = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (!operatingSystem || !architecture) {
    throw new RemoteAgentPlatformProbeError("Remote platform probe returned incomplete output.");
  }
  return {
    operatingSystem: operatingSystem.toLowerCase(),
    architecture: architecture.toLowerCase(),
    targetTriple: resolveRemoteAgentTargetTriple(
      operatingSystem.toLowerCase(),
      architecture.toLowerCase(),
    ),
  };
}

export async function probeRemoteAgentPlatform(
  executionTargetId: string,
): Promise<RemoteAgentPlatformInfo> {
  const result = await runSshCommand({
    executionTargetId,
    command: "sh",
    args: ["-lc", 'printf \'%s\\n%s\\n\' "$(uname -s)" "$(uname -m)"'],
    timeoutMs: 8_000,
    maxBufferBytes: 1024,
    outputMode: "error",
  });
  return parseRemoteAgentPlatformProbe(result.stdout);
}
