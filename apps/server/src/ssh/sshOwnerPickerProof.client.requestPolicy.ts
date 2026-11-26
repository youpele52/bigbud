import type { PickerProofOperation } from "./sshOwnerPickerProof.codec.ts";

export function proofRequestPolicy(operation: PickerProofOperation) {
  const workspaceWrite =
    operation.kind === "proofWorkspaceCreate" ||
    operation.kind === "proofWorkspaceWrite" ||
    operation.kind === "proofWorkspaceCreateDirectory" ||
    operation.kind === "proofWorkspaceDeleteEntry" ||
    operation.kind === "workspaceRename" ||
    operation.kind === "workspaceAppend" ||
    operation.kind === "proofWorkspaceWriteBegin" ||
    operation.kind === "proofWorkspaceWriteChunk" ||
    operation.kind === "proofWorkspaceWriteCommit" ||
    operation.kind === "proofWorkspaceWriteAbort" ||
    operation.kind === "proofGuardedWriteApply";
  const proofMutation =
    workspaceWrite ||
    operation.kind === "proofDeploymentStageBegin" ||
    operation.kind === "proofDeploymentManifestPut" ||
    (operation.kind === "proofDeploymentAction" && deploymentActionMutates(operation.action)) ||
    operation.kind === "proofOpencodeOpen" ||
    operation.kind === "unlockSyntheticPosixPassword" ||
    operation.kind === "proofOpencodeClose" ||
    operation.kind === "gitUploadOpen" ||
    operation.kind === "gitUploadClose" ||
    operation.kind === "gitReceiveOpen" ||
    operation.kind === "gitReceiveClose" ||
    operation.kind === "providerLeaseOpen" ||
    operation.kind === "providerLeaseClose" ||
    operation.kind === "runThreadShell" ||
    operation.kind === "runProviderWorkspaceShell" ||
    operation.kind === "runAcpCommand" ||
    operation.kind === "runAcpShell" ||
    operation.kind === "shellClose" ||
    operation.kind === "deploymentStepOpen" ||
    operation.kind === "deploymentStepCancel" ||
    operation.kind === "clientRelayLeaseOpen" ||
    operation.kind === "clientRelayLeaseClose" ||
    operation.kind === "proofWorkspaceModePublish" ||
    operation.kind === "proofGitTrackedPush" ||
    operation.kind === "openProofTerminal" ||
    operation.kind === "prepareProofTerminal" ||
    operation.kind === "cancelProofTerminalReservation" ||
    operation.kind === "closeProofTerminal" ||
    operation.kind === "proofTerminalInput" ||
    operation.kind === "proofTerminalResize" ||
    operation.kind === "openProofAgentProxy" ||
    operation.kind === "openProofClientRelay" ||
    operation.kind === "openProofCodex" ||
    operation.kind === "openProofPi" ||
    operation.kind === "openProofPeerRelay" ||
    operation.kind === "openProofGitAdvertisement" ||
    operation.kind === "openProofGitUpload" ||
    operation.kind === "closeProofAgentProxy" ||
    operation.kind === "proofRunThreadShell" ||
    operation.kind === "proofRunProviderWorkspaceShell" ||
    operation.kind === "proofRunAcpCommand" ||
    (operation.kind === "proofAgentAction" && agentActionMutates(operation.action));
  const longWorkspaceOperation =
    workspaceWrite ||
    operation.kind === "proofWorkspaceRead" ||
    operation.kind === "proofWorkspaceSnapshot" ||
    operation.kind === "proofWorkspaceModeInspect" ||
    operation.kind === "proofWorkspaceModePublish" ||
    operation.kind === "proofGitTrackedPush" ||
    operation.kind === "proofWorkspaceIndex" ||
    operation.kind === "proofWorkspaceContentSearch" ||
    operation.kind === "proofDeploymentHostProbe" ||
    operation.kind === "proofDeploymentCompletion" ||
    operation.kind === "proofDeploymentAction" ||
    operation.kind === "proofRunThreadShell" ||
    operation.kind === "proofRunProviderWorkspaceShell" ||
    operation.kind === "proofRunAcpCommand" ||
    (operation.kind === "proofWorkspaceGit" && operation.action !== "isInsideWorkTree");
  const grantTimeout = "pid" in operation ? 2_000 : undefined;
  const agentReply =
    operation.kind === "proofAgentAction" ? agentActionReplyTimeout(operation.action) : undefined;
  const deploymentReply =
    operation.kind === "proofDeploymentAction"
      ? deploymentActionTimeout(operation.action)
      : undefined;
  const deploymentStage =
    operation.kind === "proofDeploymentStageBegin" ||
    operation.kind === "proofDeploymentManifestPut";
  const replyTimeout =
    operation.kind === "closeProofAgentProxy"
      ? operation.timeoutMs + 2_000
      : agentReply !== undefined
        ? agentReply
        : deploymentReply !== undefined
          ? deploymentReply
          : deploymentStage
            ? 65_000
            : (grantTimeout ?? (longWorkspaceOperation ? "workspace" : undefined));
  return { proofMutation, grantTimeout, replyTimeout } as const;
}

/** Reattach is a read of a retained outcome; cancellation changes only this lease. */
function deploymentActionMutates(action: string): boolean {
  return action !== "reattach" && action !== "cancel";
}

/** Owner caps: fetch 5 min, publish 2 min, start 5 min, upload/reset 60 s, control 10 s. */
function deploymentActionTimeout(action: string): number | undefined {
  switch (action) {
    case "fetch":
      return 300_000;
    case "publish":
      return 120_000;
    case "start":
      return 300_000;
    case "archiveUpload":
    case "reset":
      return 60_000;
    case "cancel":
    case "reattach":
      return 10_000;
    default:
      return undefined;
  }
}

/** Only the owner's mutating verbs risk an unconfirmed remote effect. */
function agentActionMutates(action: string): boolean {
  return action !== "platformProbe" && action !== "status";
}

/** Owner caps: platform 8 s, status 15 s, install/update/remove 60 s, control 30 s. */
function agentActionReplyTimeout(action: string): number {
  switch (action) {
    case "platformProbe":
      return 10_000;
    case "status":
      return 17_000;
    case "install":
    case "update":
    case "remove":
      return 62_000;
    default:
      return 32_000;
  }
}
