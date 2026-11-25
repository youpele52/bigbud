import {
  writeProofProviderScope,
  type ProofProviderProbeOperation,
} from "./sshOwnerPickerProof.codec.provider.ts";
import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  writeProofAgentProxy,
  type ProofAgentProxyOperation,
} from "./sshOwnerPickerProof.codec.agentProxy.ts";
import {
  writeWorkspaceGit,
  type ProofWorkspaceGitOperation,
} from "./sshOwnerPickerProof.codec.git.ts";
import {
  writeDeploymentHostProbe,
  writeProofDeploymentAction,
  writeProofStageBegin,
  writeProofManifestPut,
  type ProofDeploymentActionOperation,
  type ProofDeploymentManifestOperation,
  type ProofDeploymentStageOperation,
  type ProofDeploymentProbeOperation,
  type ProofDeploymentCompletionOperation,
} from "./sshOwnerPickerProof.codec.deployment.ts";
import {
  writeProofTrackedPush,
  type ProofTrackedPushOperation,
} from "./sshOwnerPickerProof.codec.trackedPush.ts";
import {
  writeProofOpencode,
  type ProofOpencodeOperation,
} from "./sshOwnerPickerProof.codec.opencode.ts";
import {
  writeGuardedWriteOperation,
  type GuardedWriteOperation,
} from "./sshOwnerPickerProof.codec.guardedWrite.ts";
import {
  writeProofTerminalOperation,
  type ProofTerminalOperation,
} from "./sshOwnerPickerProof.codec.terminal.ts";
import { EMPTY, message } from "./sshOwnerPickerProof.codec.wire.ts";
import {
  writeWorkspaceContentSearch,
  writeWorkspaceList,
  writeWorkspaceRead,
  writeWorkspaceRoot,
  writeWorkspaceWrite,
  type ProofWorkspaceContentSearchOperation,
  type ProofWorkspaceIndexOperation,
  type ProofWorkspaceListOperation,
  type ProofWorkspaceReadOperation,
  type ProofWorkspaceSnapshotOperation,
  type ProofWorkspaceWriteOperation,
} from "./sshOwnerPickerProof.codec.workspace.ts";
import {
  writeWorkspaceCreateDirectory,
  writeWorkspaceDeleteEntry,
  writeWorkspaceWriteStage,
  type ProofWorkspaceCreateDirectoryOperation,
  type ProofWorkspaceDeleteEntryOperation,
  type ProofWorkspaceWriteStageOperation,
} from "./sshOwnerPickerProof.codec.workspace.mutation.ts";
import {
  writeWorkspaceModeInspect,
  writeWorkspaceModePublish,
  type ProofWorkspaceModeInspectOperation,
  type ProofWorkspaceModePublishOperation,
} from "./sshOwnerPickerProof.codec.workspaceMode.ts";
import {
  writeProofShellOperation,
  type ProofShellOperation,
} from "./sshOwnerPickerProof.codec.shell.ts";
import {
  writeProofAgentAction,
  type ProofAgentActionOperation,
} from "./sshOwnerPickerProof.codec.agentAction.ts";
import {
  writeProofPeerEnrollment,
  type ProofPeerEnrollmentOperation,
} from "./sshOwnerPickerProof.codec.peerEnrollment.ts";
import { refuseReservedTransferOperation } from "./sshOwnerPickerProof.codec.transfer.ts";

export type {
  PickerProofConnection,
  PickerProofTrust,
} from "./sshOwnerPickerProof.codec.outcome.ts";
export {
  decodeOwnerError,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
  type PickerProofOwnerErrorCode,
} from "./sshOwnerPickerProof.codec.wire.ts";

export { encodeStorageResult, encodeStorageSnapshot } from "./sshOwnerPickerProof.codec.storage.ts";
export { decodeOwnerFrame, type Frame } from "./sshOwnerPickerProof.codec.decode.ts";

export const OWNER_MAJOR = 1;
export const OWNER_MINOR = 0;

export type PickerProofOperation =
  | { readonly kind: "inspectTrust" | "connect" | "disconnect" | "proofSampleHealth" }
  | { readonly kind: "approveTrust"; readonly challenge: Uint8Array }
  | { readonly kind: "listFolders"; readonly path?: string | undefined }
  | { readonly kind: "listAliases" }
  | ProofTerminalOperation
  | ProofWorkspaceReadOperation
  | ProofWorkspaceListOperation
  | ProofWorkspaceSnapshotOperation
  | ProofWorkspaceIndexOperation
  | { readonly kind: "proofWorkspaceReadiness"; readonly workspaceRoot: string }
  | ProofWorkspaceWriteOperation
  | ProofWorkspaceCreateDirectoryOperation
  | ProofWorkspaceDeleteEntryOperation
  | ProofWorkspaceWriteStageOperation
  | GuardedWriteOperation
  | ProofWorkspaceContentSearchOperation
  | ProofWorkspaceGitOperation
  | ProofAgentProxyOperation
  | ProofProviderProbeOperation
  | ProofDeploymentProbeOperation
  | ProofDeploymentCompletionOperation
  | ProofDeploymentStageOperation
  | ProofDeploymentManifestOperation
  | ProofDeploymentActionOperation
  | ProofWorkspaceModeInspectOperation
  | ProofWorkspaceModePublishOperation
  | ProofTrackedPushOperation
  | ProofOpencodeOperation
  | { readonly kind: "unlockSyntheticPosixPassword" }
  | ProofShellOperation
  | ProofAgentActionOperation
  | ProofPeerEnrollmentOperation;

export interface PickerProofRequest {
  readonly requestId: Uint8Array;
  readonly ownerEpoch: Uint8Array;
  readonly generation: Uint8Array;
  readonly targetId: string;
  readonly operation: PickerProofOperation;
}

function writeHello(writer: WireWriter, profileBinding: Uint8Array, major: number) {
  writer.fieldUint(1, major);
  writer.fieldUint(2, OWNER_MINOR);
  writer.fieldBytes(3, profileBinding);
}

export const encodeHello = (profileBinding: Uint8Array, major: number, capability?: Uint8Array) =>
  message(1, (writer) => {
    writeHello(writer, profileBinding, major);
    if (capability !== undefined) writer.fieldBytes(4, capability);
  });

export const encodeAttachProbe = (clientNonce: Uint8Array) =>
  message(11, (writer) => writer.fieldBytes(1, clientNonce));

export const encodeAttachHello = (profileBinding: Uint8Array, major: number, proof: Uint8Array) =>
  message(13, (writer) => {
    const hello = new WireWriter();
    writeHello(hello, profileBinding, major);
    writer.fieldRepeatedMessage(1, hello.finish());
    writer.fieldBytes(2, proof);
  });

export const encodeRequest = (request: PickerProofRequest, grant?: Uint8Array) =>
  message(grant === undefined ? 5 : 3, (writer) => {
    const { requestId, ownerEpoch, generation, targetId, operation } = request;
    // C15 / W2 T-xfer: reserved transfer verbs are fixture-only and cannot be
    // emitted by the product encoder, even from a cast operation value.
    refuseReservedTransferOperation(operation);
    writer.fieldBytes(1, requestId);
    writer.fieldBytes(2, ownerEpoch);
    writer.fieldBytes(3, generation);
    writer.fieldString(4, targetId);
    if (grant !== undefined) writer.fieldBytes(5, grant);
    const operands = new WireWriter();
    switch (operation.kind) {
      case "inspectTrust":
        writer.fieldRepeatedMessage(10, EMPTY);
        break;
      case "approveTrust":
        operands.fieldBytes(1, operation.challenge);
        writer.fieldRepeatedMessage(11, operands.finish());
        break;
      case "connect":
        writer.fieldRepeatedMessage(12, EMPTY);
        break;
      case "disconnect":
        writer.fieldRepeatedMessage(13, EMPTY);
        break;
      case "listFolders":
        if (operation.path !== undefined) operands.fieldRepeatedString(1, operation.path);
        writer.fieldRepeatedMessage(14, operands.finish());
        break;
      case "listAliases":
        writer.fieldRepeatedMessage(76, EMPTY);
        break;
      case "openProofTerminal":
      case "proofTerminalCwd":
      case "proofTerminalReplay":
      case "proofTerminalStatus":
      case "closeProofTerminal":
      case "proofTerminalInput":
      case "proofTerminalResize":
      case "prepareProofTerminal":
      case "cancelProofTerminalReservation":
        writeProofTerminalOperation(writer, operands, operation);
        break;
      case "probeProofPi":
      case "probeProofCodex":
        writeProofProviderScope(operands, operation);
        writer.fieldRepeatedMessage(
          operation.kind === "probeProofCodex" ? 38 : 40,
          operands.finish(),
        );
        break;
      case "openProofPeerRelay":
      case "openProofGitUpload":
      case "openProofGitAdvertisement":
      case "openProofPi":
      case "openProofCodex":
      case "openProofClientRelay":
      case "openProofAgentProxy":
      case "proofAgentProxyStatus":
      case "closeProofAgentProxy":
        writeProofAgentProxy(writer, operands, operation);
        break;
      case "proofWorkspaceRead":
        writeWorkspaceRead(operands, operation);
        writer.fieldRepeatedMessage(18, operands.finish());
        break;
      case "proofWorkspaceList":
      case "proofWorkspaceSnapshot":
        writeWorkspaceList(operands, operation);
        writer.fieldRepeatedMessage(
          operation.kind === "proofWorkspaceList" ? 19 : 20,
          operands.finish(),
        );
        break;
      case "proofWorkspaceIndex":
      case "proofWorkspaceReadiness":
        writeWorkspaceRoot(operands, operation);
        writer.fieldRepeatedMessage(
          operation.kind === "proofWorkspaceIndex" ? 21 : 54,
          operands.finish(),
        );
        break;
      case "proofGuardedWriteBegin":
      case "proofGuardedWriteChunk":
      case "proofGuardedWriteCommit":
      case "proofGuardedWriteAbort":
      case "proofGuardedWriteApply":
        writeGuardedWriteOperation(writer, operation);
        break;
      case "proofWorkspaceCreate":
      case "proofWorkspaceWrite":
        writeWorkspaceWrite(operands, operation);
        writer.fieldRepeatedMessage(
          operation.kind === "proofWorkspaceCreate" ? 60 : 22,
          operands.finish(),
        );
        break;
      case "proofWorkspaceCreateDirectory":
        writeWorkspaceCreateDirectory(operands, operation);
        writer.fieldRepeatedMessage(61, operands.finish());
        break;
      case "proofWorkspaceDeleteEntry":
        writeWorkspaceDeleteEntry(operands, operation);
        writer.fieldRepeatedMessage(62, operands.finish());
        break;
      case "proofWorkspaceWriteBegin":
      case "proofWorkspaceWriteChunk":
      case "proofWorkspaceWriteCommit":
      case "proofWorkspaceWriteAbort": {
        writeWorkspaceWriteStage(operands, operation);
        const field = {
          proofWorkspaceWriteBegin: 63,
          proofWorkspaceWriteChunk: 64,
          proofWorkspaceWriteCommit: 65,
          proofWorkspaceWriteAbort: 66,
        }[operation.kind];
        writer.fieldRepeatedMessage(field, operands.finish());
        break;
      }
      case "proofWorkspaceContentSearch":
        writeWorkspaceContentSearch(operands, operation);
        writer.fieldRepeatedMessage(23, operands.finish());
        break;
      case "proofSampleHealth":
        writer.fieldRepeatedMessage(24, EMPTY);
        break;
      case "unlockSyntheticPosixPassword":
        writer.fieldRepeatedMessage(53, EMPTY);
        break;
      case "proofOpencodeOpen":
      case "proofOpencodeStatus":
      case "proofOpencodeClose":
        writeProofOpencode(writer, operation);
        break;
      case "proofGitTrackedPush":
        writeProofTrackedPush(operands, operation);
        writer.fieldRepeatedMessage(49, operands.finish());
        break;
      case "proofWorkspaceModePublish":
        writeWorkspaceModePublish(operands, operation);
        writer.fieldRepeatedMessage(48, operands.finish());
        break;
      case "proofWorkspaceModeInspect":
        writeWorkspaceModeInspect(operands, operation);
        writer.fieldRepeatedMessage(47, operands.finish());
        break;
      case "proofDeploymentManifestPut":
        writeProofManifestPut(operands, operation);
        writer.fieldRepeatedMessage(46, operands.finish());
        break;
      case "proofDeploymentStageBegin":
        writeProofStageBegin(operands, operation);
        writer.fieldRepeatedMessage(44, operands.finish());
        break;
      case "proofDeploymentAction":
        writeProofDeploymentAction(operands, operation);
        writer.fieldRepeatedMessage(73, operands.finish());
        break;
      case "proofDeploymentCompletion":
      case "proofDeploymentHostProbe":
        writeDeploymentHostProbe(operands, operation);
        writer.fieldRepeatedMessage(
          operation.kind === "proofDeploymentHostProbe" ? 35 : 36,
          operands.finish(),
        );
        break;
      case "proofWorkspaceGit":
        writeWorkspaceGit(operands, operation);
        writer.fieldRepeatedMessage(25, operands.finish());
        break;
      case "proofRunThreadShell":
      case "proofRunProviderWorkspaceShell":
      case "proofRunAcpCommand":
        writeProofShellOperation(writer, operands, operation);
        break;
      case "proofAgentAction":
        writeProofAgentAction(writer, operands, operation);
        break;
      case "proofEnsurePeerCoordinatorKey":
      case "proofInspectPeerHostKey":
        writeProofPeerEnrollment(writer, operands, operation);
        break;
    }
  });
