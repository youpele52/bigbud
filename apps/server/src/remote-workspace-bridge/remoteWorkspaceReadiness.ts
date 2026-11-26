import { isSshOwnerDevFixtureSelected } from "../ssh/sshOwnerSelection.ts";
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

/** A bound selected-owner capability. It is not a shell runner. */
export interface SelectedWorkspaceOwnerCapability {
  readonly targetId: string;
  readonly workspaceRoot: string;
  readonly withOwner: <A>(
    targetId: string,
    use: (owner: {
      probeProofWorkspaceReadiness(input: {
        executionTargetId: string;
        workspaceRoot: string;
      }): Promise<RemoteWorkspaceReadiness>;
    }) => Promise<A>,
  ) => Promise<A>;
}

export type RemoteWorkspaceCommandRunner = (input: {
  readonly workspaceTarget: WorkspaceTarget;
  readonly timeoutMs: number;
}) => Promise<ProcessRunResult>;

export type RemoteWorkspaceReadinessProbe = (
  workspaceTarget: WorkspaceTarget,
) => Promise<RemoteWorkspaceReadiness>;

type UnsupportedBridgeOperation = "readiness" | "session-filesystem";

export class SelectedSshOwnerWorkspaceBridgeError extends Error {
  readonly code = "unsupported-by-selected-ssh-owner";

  constructor(
    readonly operation: UnsupportedBridgeOperation,
    detail?: string,
  ) {
    super(
      detail
        ? `Remote workspace ${operation} is unavailable with the source-dev SSH owner: ${detail}.`
        : `Remote workspace ${operation} is unavailable with the source-dev SSH owner.`,
    );
    this.name = "SelectedSshOwnerWorkspaceBridgeError";
  }
}

export function assertRemoteWorkspaceBridgeOperationSupported(
  workspaceTarget: WorkspaceTarget,
  operation: UnsupportedBridgeOperation,
  hasBoundCapability = false,
): void {
  // This entry point has no selected owner capability; it must not dispatch
  // generic shell or managed-agent operations as a substitute.
  if (
    isSshOwnerDevFixtureSelected() &&
    workspaceTarget.location === "remote" &&
    !hasBoundCapability
  ) {
    throw new SelectedSshOwnerWorkspaceBridgeError(operation);
  }
}

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
    assertRemoteWorkspaceBridgeOperationSupported(workspaceTarget, "readiness");
    if (!workspaceTarget.cwd) {
      throw new Error("Remote workspace readiness requires an explicit workspace root.");
    }
    const result = await run({ workspaceTarget, timeoutMs: READINESS_TIMEOUT_MS });
    const [os = "", architecture = ""] = result.stdout.trim().split(/\r?\n/u);
    return { os: normalizeRemoteOs(os), architecture: normalizeRemoteArchitecture(architecture) };
  };
}

export const probeRemoteWorkspaceReadiness = makeRemoteWorkspaceReadinessProbe();

/** A selected caller supplies its admitted owner capability, never a shell runner. */
export async function probeSelectedSshOwnerWorkspaceReadiness(
  owner: {
    probeProofWorkspaceReadiness(input: {
      executionTargetId: string;
      workspaceRoot: string;
    }): Promise<RemoteWorkspaceReadiness>;
  },
  input: { executionTargetId: string; workspaceRoot: string },
): Promise<RemoteWorkspaceReadiness> {
  const { os, architecture } = await owner.probeProofWorkspaceReadiness(input);
  return { os: normalizeRemoteOs(os), architecture: normalizeRemoteArchitecture(architecture) };
}

/** Readiness for a bound selected owner, without a provider-supplied shell probe. */
export function makeSelectedOwnerReadinessProbe(
  capability: SelectedWorkspaceOwnerCapability,
): RemoteWorkspaceReadinessProbe {
  return async (workspaceTarget) => {
    if (
      workspaceTarget.location !== "remote" ||
      workspaceTarget.executionTargetId !== capability.targetId ||
      workspaceTarget.cwd !== capability.workspaceRoot
    ) {
      throw new SelectedSshOwnerWorkspaceBridgeError("readiness");
    }
    const readiness = await capability.withOwner(capability.targetId, (owner) =>
      owner.probeProofWorkspaceReadiness({
        executionTargetId: capability.targetId,
        workspaceRoot: capability.workspaceRoot,
      }),
    );
    return {
      os: normalizeRemoteOs(readiness.os),
      architecture: normalizeRemoteArchitecture(readiness.architecture),
    };
  };
}
