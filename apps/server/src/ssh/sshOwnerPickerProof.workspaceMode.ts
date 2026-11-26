import type {
  WorkspaceModeSshInspectOutcome,
  WorkspaceModeSshOwner,
  WorkspaceModeSshPublishOutcome,
  WorkspaceModeSshScope,
} from "../remote-backend/workspaceMode.ssh.owner.ts";
import type { ProofWorkspaceModeInspection } from "./sshOwnerPickerProof.codec.workspaceMode.ts";

interface WorkspaceModeProofPort {
  inspectProofWorkspaceMode(input: {
    readonly executionTargetId: string;
    readonly root: string;
  }): Promise<ProofWorkspaceModeInspection>;
  publishProofWorkspaceMode(
    request: Parameters<WorkspaceModeSshOwner["publishWorkspaceMode"]>[0],
  ): Promise<WorkspaceModeSshPublishOutcome>;
}

const refused = { kind: "failed", reason: "refused" } as const;
const unavailable = { kind: "failed", reason: "unavailable" } as const;
const uncertain = { kind: "uncertain" } as const;

function inspectOutcome(
  scope: WorkspaceModeSshScope,
  result: ProofWorkspaceModeInspection,
): WorkspaceModeSshInspectOutcome {
  if (result.state === "refused") {
    switch (result.reason) {
      case "notLinux":
        return { kind: "unsupported", reason: "not-linux" };
      case "noMachineId":
        return { kind: "unsupported", reason: "no-machine-id" };
      case "missingFolder":
        return { kind: "failed", reason: "missing-folder" };
      case "unsafeStorage":
        return { kind: "failed", reason: "unsafe-storage" };
    }
  }
  return {
    kind: "ready",
    observation: {
      ...scope,
      physicalRoot: result.physicalRoot,
      identity: {
        hostIdentity: result.hostIdentity,
        accountUid: result.accountUid,
        realpathSha256: result.realpathSha256,
      },
      generation: result.generation,
      publicationToken: Uint8Array.from(result.publicationToken),
    },
    currentRecord: result.currentRecord ?? null,
  };
}

/** Isolated composition only. The port's fixed native deadline bounds its lifetime. */
export function workspaceModeForPickerProof(
  binding: WorkspaceModeSshScope,
  port: WorkspaceModeProofPort,
): WorkspaceModeSshOwner {
  const scope = Object.freeze({ ...binding });
  const matches = (request: WorkspaceModeSshScope) =>
    request.executionTargetId === scope.executionTargetId &&
    request.workspaceRoot === scope.workspaceRoot;
  return {
    async inspectWorkspaceMode(request, signal) {
      if (!matches(request)) return refused;
      if (signal.aborted) return unavailable;
      try {
        const result = await port.inspectProofWorkspaceMode({
          executionTargetId: scope.executionTargetId,
          root: scope.workspaceRoot,
        });
        return signal.aborted ? unavailable : inspectOutcome(scope, result);
      } catch {
        return unavailable;
      }
    },
    async publishWorkspaceMode(request, signal) {
      if (!matches(request.observation)) return refused;
      if (signal.aborted) return unavailable;
      try {
        const result = await port.publishProofWorkspaceMode(request);
        return signal.aborted ? uncertain : result;
      } catch {
        return uncertain;
      }
    },
  };
}
