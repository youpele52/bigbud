import type { ProcessRunResult } from "../utils/processRunner.ts";
import type { WorkspaceTarget } from "../workspace-target/workspaceTarget.ts";
import { runToolCommand, resolveToolTransportTarget } from "../tool-transport/toolTransport.ts";

const READINESS_TIMEOUT_MS = 10_000;
const READINESS_OUTPUT_LIMIT = 4 * 1024;
const READINESS_SCRIPT = [
  "set -eu",
  'test -d "$PWD"',
  'printf "%s\\n" "$(uname -s 2>/dev/null || printf unknown)"',
  'printf "%s\\n" "$(uname -m 2>/dev/null || printf unknown)"',
].join("\n");

export interface RemoteWorkspaceReadiness {
  readonly os: "darwin" | "linux";
  readonly architecture: string;
}

export type RemoteWorkspaceCommandRunner = (input: {
  readonly workspaceTarget: WorkspaceTarget;
  readonly timeoutMs: number;
}) => Promise<ProcessRunResult>;

export type RemoteWorkspaceReadinessProbe = (
  workspaceTarget: WorkspaceTarget,
) => Promise<RemoteWorkspaceReadiness>;

function normalizeRemoteOs(value: string): RemoteWorkspaceReadiness["os"] {
  switch (value.trim().toLowerCase()) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    default:
      throw new Error(
        `Remote workspace host '${value.trim() || "unknown"}' is unsupported; Linux or macOS with a POSIX shell is required.`,
      );
  }
}

function normalizeRemoteArchitecture(value: string): string {
  const architecture = value.trim().toLowerCase();
  if (["aarch64", "amd64", "arm64", "x86_64"].includes(architecture)) return architecture;
  throw new Error(
    `Remote workspace architecture '${architecture || "unknown"}' is unsupported; x86_64/amd64 or arm64/aarch64 is required.`,
  );
}

export function makeRemoteWorkspaceReadinessProbe(
  run: RemoteWorkspaceCommandRunner = ({ workspaceTarget, timeoutMs }) =>
    runToolCommand({
      target: resolveToolTransportTarget(workspaceTarget),
      command: "sh",
      args: ["-lc", READINESS_SCRIPT],
      timeoutMs,
      maxBufferBytes: READINESS_OUTPUT_LIMIT,
      outputMode: "error",
    }),
): RemoteWorkspaceReadinessProbe {
  return async (workspaceTarget) => {
    if (!workspaceTarget.cwd) {
      throw new Error("Remote workspace readiness requires an explicit workspace root.");
    }
    const result = await run({ workspaceTarget, timeoutMs: READINESS_TIMEOUT_MS });
    const [os = "", architecture = ""] = result.stdout.trim().split(/\r?\n/u);
    return { os: normalizeRemoteOs(os), architecture: normalizeRemoteArchitecture(architecture) };
  };
}

export const probeRemoteWorkspaceReadiness = makeRemoteWorkspaceReadinessProbe();
