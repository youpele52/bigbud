import { runSshCommand } from "../ssh/sshProcess.ts";
import { runRemoteAgentDiagnosedCommand } from "./remoteAgentDiagnostics.ts";
import {
  buildRemoteAgentPreflightScript,
  parseRemoteAgentPreflight,
  type RemoteAgentPreflightReport,
} from "./remoteAgentInstall.preflight.ts";
import {
  resolveRemoteAgentTargetTriple,
  type RemoteAgentTargetTriple,
} from "./remoteAgentArtifact.ts";

export interface RemoteAgentPlatformInfo {
  readonly operatingSystem: string;
  readonly architecture: string;
  readonly targetTriple: RemoteAgentTargetTriple | null;
  /** Install prerequisites gathered in the same round trip; absent from older probe doubles. */
  readonly preflight?: RemoteAgentPreflightReport;
}

export class RemoteAgentPlatformProbeError extends Error {
  readonly _tag = "RemoteAgentPlatformProbeError";

  constructor(message: string) {
    super(message);
    this.name = "RemoteAgentPlatformProbeError";
  }
}

export function parseRemoteAgentPlatformProbe(output: string): RemoteAgentPlatformInfo {
  const [operatingSystem, architecture, ...preflightLines] = output
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
    ...(preflightLines.length > 0 ? { preflight: parseRemoteAgentPreflight(preflightLines) } : {}),
  };
}

export async function probeRemoteAgentPlatform(
  executionTargetId: string,
): Promise<RemoteAgentPlatformInfo> {
  const result = await runRemoteAgentDiagnosedCommand(runSshCommand, "platform", {
    executionTargetId,
    command: "sh",
    args: [
      "-lc",
      [
        'printf \'%s\\n%s\\n\' "$(uname -s)" "$(uname -m)"',
        // Prerequisite facts are Linux-specific; other systems stop at the unsupported triple.
        'if [ "$(uname -s)" = Linux ]; then',
        buildRemoteAgentPreflightScript(),
        "fi",
      ].join("\n"),
    ],
    timeoutMs: 8_000,
    maxBufferBytes: 4096,
  });
  return parseRemoteAgentPlatformProbe(result.stdout);
}
