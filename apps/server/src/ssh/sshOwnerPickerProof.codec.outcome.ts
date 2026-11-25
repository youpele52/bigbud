import {
  readProofOpencode,
  type ProofOpencodeState,
} from "./sshOwnerPickerProof.codec.opencode.ts";
import type { ServerListRemoteFoldersResult } from "@bigbud/contracts/server/server.remoteFolders";

import {
  readGuardedWriteStage,
  readGuardedWriteResult,
  type GuardedWriteResult,
  type GuardedWriteStage,
} from "./sshOwnerPickerProof.codec.guardedWrite.ts";
import { readWorkspaceFile } from "./sshOwnerPickerProof.codec.workspaceFile.ts";
import {
  readWorkspaceEntryMutation,
  readWorkspaceWriteStage,
  type PickerProofWorkspaceEntryMutation,
  type PickerProofWorkspaceWriteStage,
} from "./sshOwnerPickerProof.codec.workspace.mutation.ts";
import { decodeMessage } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  readProofAgentProxyStatus,
  type ProofAgentProxyStatus,
} from "./sshOwnerPickerProof.codec.agentProxy.ts";
import {
  readWorkspaceGitResult,
  type PickerProofWorkspaceGitResult,
} from "./sshOwnerPickerProof.codec.git.ts";
import {
  readProofTerminal,
  readProofTerminalCwd,
  readProofTerminalReplay,
  readProofTerminalReservation,
  type PickerProofTerminalReplay,
  type PickerProofTerminal,
  type ProofTerminalReservation,
} from "./sshOwnerPickerProof.codec.terminal.ts";
import {
  boolValue,
  bytesValue,
  decodeOwnerError,
  decodeJumpStage,
  type JumpFailure,
  EMPTY,
  invalid,
  PROOF_TOKEN_BYTES,
  stringValue,
  uintValue,
} from "./sshOwnerPickerProof.codec.wire.ts";
import {
  readWorkspaceContentMatches,
  readWorkspaceDirectory,
  readWorkspaceIndex,
  readWorkspaceSnapshot,
  type PickerProofWorkspaceContentMatches,
  type PickerProofWorkspaceDirectory,
  type PickerProofWorkspaceFile,
  type PickerProofWorkspaceIndex,
} from "./sshOwnerPickerProof.codec.workspace.ts";

import {
  readDeploymentHostProbeResult,
  type ProofDeploymentProbeResult,
} from "./sshOwnerPickerProof.codec.deployment.ts";

import {
  readWorkspaceModeInspection,
  readWorkspaceModePublication,
  type ProofWorkspaceModeInspection,
} from "./sshOwnerPickerProof.codec.workspaceMode.ts";

import {
  readWorkspaceReadiness,
  type PickerProofWorkspaceReadiness,
} from "./sshOwnerPickerProof.codec.readiness.ts";
import {
  readProofAcpCommandResult,
  readProofShellResult,
  type ProofAcpCommandResult,
  type ProofShellResult,
} from "./sshOwnerPickerProof.codec.shell.ts";
import {
  readProofAgentActionResult,
  type AgentActionResult,
} from "./sshOwnerPickerProof.codec.agentAction.ts";
import {
  readPeerCoordinatorKey,
  readPeerHostKey,
  type PeerCoordinatorKeyMetadata,
  type PeerHostKeyMetadata,
} from "./sshOwnerPickerProof.codec.peerEnrollment.ts";
import {
  readProofAliases,
  type PickerProofAliasList,
} from "./sshOwnerPickerProof.codec.aliases.ts";

export type { PickerProofTerminal } from "./sshOwnerPickerProof.codec.terminal.ts";

const MAX_FOLDERS = 1_000;

export type PickerProofTrust = {
  readonly keyType: string;
  readonly fingerprint: string;
  readonly jumpLeg?: number;
} & (
  | { readonly state: "verified" }
  | { readonly state: "approvalRequired"; readonly challenge: Uint8Array }
);
export type PickerProofConnection = { readonly state: "connected" | "disconnected" };

export type Outcome =
  | { kind: "error"; code: ReturnType<typeof decodeOwnerError>; jumpFailure?: JumpFailure }
  | { kind: "trust"; value: PickerProofTrust }
  | { kind: "connection"; value: PickerProofConnection }
  | { kind: "folders"; value: ServerListRemoteFoldersResult }
  | { kind: "proofTerminal"; value: PickerProofTerminal }
  | { kind: "proofTerminalCwd"; value: string }
  | { kind: "proofTerminalReplay"; value: PickerProofTerminalReplay }
  | { kind: "proofTerminalReservation"; value: ProofTerminalReservation }
  | { kind: "proofWorkspaceFile"; value: PickerProofWorkspaceFile }
  | { kind: "proofWorkspaceDirectory"; value: PickerProofWorkspaceDirectory }
  | { kind: "proofWorkspaceReadiness"; value: PickerProofWorkspaceReadiness }
  | { kind: "proofWorkspaceSnapshot"; value: string }
  | { kind: "proofWorkspaceIndex"; value: PickerProofWorkspaceIndex }
  | { kind: "proofWorkspaceWritten" }
  | { kind: "proofWorkspaceCreateResult"; value: "created" | "alreadyExists" }
  | {
      kind: "proofWorkspaceEntryMutation";
      value: PickerProofWorkspaceEntryMutation;
    }
  | {
      kind: "proofWorkspaceWriteStage";
      value: PickerProofWorkspaceWriteStage;
    }
  | { kind: "proofGuardedWriteStage"; value: GuardedWriteStage }
  | { kind: "proofGuardedWriteResult"; value: GuardedWriteResult }
  | { kind: "proofWorkspaceContentMatches"; value: PickerProofWorkspaceContentMatches }
  | { kind: "proofHealth"; value: boolean }
  | { kind: "proofWorkspaceGit"; value: PickerProofWorkspaceGitResult }
  | { kind: "proofDeploymentHostResult"; value: ProofDeploymentProbeResult }
  | { kind: "proofPiVersion"; value: PickerProofWorkspaceGitResult }
  | { kind: "proofCodexVersion"; value: PickerProofWorkspaceGitResult }
  | { kind: "proofAgentProxy"; value: ProofAgentProxyStatus }
  | { kind: "proofWorkspaceModeInspection"; value: ProofWorkspaceModeInspection }
  | {
      kind: "proofWorkspaceModePublication";
      value: ReturnType<typeof readWorkspaceModePublication>;
    }
  | { kind: "proofGitTrackedPush"; value: ProofTrackedPushStatus }
  | { kind: "proofOpencode"; value: ProofOpencodeState }
  | { kind: "proofThreadShell"; value: ProofShellResult }
  | { kind: "proofProviderShell"; value: ProofShellResult }
  | { kind: "proofAcpCommand"; value: ProofAcpCommandResult }
  | { kind: "proofAgentAction"; value: AgentActionResult }
  | { kind: "proofPeerCoordinatorKey"; value: PeerCoordinatorKeyMetadata }
  | { kind: "proofPeerHostKey"; value: PeerHostKeyMetadata }
  | { kind: "proofAliases"; value: PickerProofAliasList }
  | { kind: "proofSyntheticPosixPasswordUnlocked" };

import {
  readProofTrackedPushStatus,
  type ProofTrackedPushStatus,
} from "./sshOwnerPickerProof.codec.trackedPush.ts";

function readJumpFailure(bytes: Uint8Array): JumpFailure {
  let leg: number | undefined;
  let stage: JumpFailure["stage"] | undefined;
  decodeMessage(bytes, (number, wire, reader) => {
    if (number === 1) {
      if (leg !== undefined) return invalid();
      leg = uintValue(wire, reader);
      if (leg > 5) return invalid();
    } else if (number === 2) {
      if (stage !== undefined) return invalid();
      stage = decodeJumpStage(uintValue(wire, reader));
    } else reader.skip(wire);
  });
  return { leg: leg ?? 0, stage: stage ?? invalid() };
}

export function readReply(bytes: Uint8Array) {
  let requestId = EMPTY;
  let ownerEpoch = EMPTY;
  let generation = EMPTY;
  let outcome: Outcome | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1) requestId = bytesValue(wire, reader);
    else if (field === 2) ownerEpoch = bytesValue(wire, reader);
    else if (field === 3) generation = bytesValue(wire, reader);
    else if (field >= 10) {
      if (outcome !== undefined) return invalid();
      outcome = readOutcome(field, bytesValue(wire, reader));
    } else reader.skip(wire);
  });
  return {
    kind: "reply" as const,
    requestId,
    ownerEpoch,
    generation,
    outcome: outcome ?? invalid(),
  };
}

export const readOutcome = (field: number, bytes: Uint8Array): Outcome => {
  switch (field) {
    case 10: {
      let code = 0;
      let jumpFailure: JumpFailure | undefined;
      decodeMessage(bytes, (number, wire, reader) => {
        if (number === 1) code = uintValue(wire, reader);
        else if (number === 2) {
          if (jumpFailure !== undefined) return invalid();
          jumpFailure = readJumpFailure(bytesValue(wire, reader));
        } else reader.skip(wire);
      });
      return { kind: "error", code: decodeOwnerError(code), ...(jumpFailure && { jumpFailure }) };
    }
    case 11: {
      let state = 0,
        challenge = EMPTY,
        keyType = "",
        fingerprint = "";
      let jumpLeg: number | undefined;
      decodeMessage(bytes, (number, wire, reader) => {
        if (number === 1) state = uintValue(wire, reader);
        else if (number === 2) challenge = bytesValue(wire, reader);
        else if (number === 3) keyType = stringValue(wire, reader);
        else if (number === 4) fingerprint = stringValue(wire, reader);
        else if (number === 5) {
          if (jumpLeg !== undefined) return invalid();
          jumpLeg = uintValue(wire, reader);
          if (jumpLeg < 1 || jumpLeg > 5) return invalid();
        } else reader.skip(wire);
      });
      if (!keyType || !fingerprint) return invalid();
      const key = { keyType, fingerprint, ...(jumpLeg === undefined ? {} : { jumpLeg }) };
      if (state === 1 && challenge.length === 0) {
        return { kind: "trust", value: { state: "verified", ...key } };
      }
      if (state === 2 && challenge.length === PROOF_TOKEN_BYTES) {
        return {
          kind: "trust",
          value: { state: "approvalRequired", challenge, ...key },
        };
      }
      return invalid();
    }
    case 12: {
      let state = 0;
      decodeMessage(bytes, (number, wire, reader) => {
        if (number === 1) state = uintValue(wire, reader);
        else reader.skip(wire);
      });
      if (state !== 1 && state !== 2) return invalid();
      return { kind: "connection", value: { state: state === 1 ? "connected" : "disconnected" } };
    }
    case 13: {
      let path = "",
        homePath = "",
        truncated: boolean | undefined;
      const folders: Array<{ name: string; isGitRepo: boolean }> = [];
      decodeMessage(bytes, (number, wire, reader) => {
        if (number === 1) path = stringValue(wire, reader);
        else if (number === 2) {
          if (folders.length === MAX_FOLDERS) return invalid();
          let name = "",
            isGitRepo = false;
          decodeMessage(bytesValue(wire, reader), (field, type, entry) => {
            if (field === 1) name = stringValue(type, entry);
            else if (field === 2) isGitRepo = boolValue(type, entry);
            else entry.skip(type);
          });
          if (!name.trim()) return invalid();
          folders.push({ name, isGitRepo });
        } else if (number === 3) homePath = stringValue(wire, reader);
        else if (number === 4) truncated = boolValue(wire, reader);
        else reader.skip(wire);
      });
      if (!path.trim() || !homePath.trim() || truncated === undefined) return invalid();
      return { kind: "folders", value: { path, homePath, folders, truncated } };
    }
    case 14:
      return { kind: "proofTerminal", value: readProofTerminal(bytes) };
    case 15:
      return { kind: "proofWorkspaceFile", value: readWorkspaceFile(bytes) };
    case 16:
      return { kind: "proofWorkspaceDirectory", value: readWorkspaceDirectory(bytes) };
    case 17:
      return { kind: "proofWorkspaceSnapshot", value: readWorkspaceSnapshot(bytes) };
    case 18:
      return { kind: "proofWorkspaceIndex", value: readWorkspaceIndex(bytes) };
    case 19:
      return bytes.length === 0 ? { kind: "proofWorkspaceWritten" } : invalid();
    case 20:
      return { kind: "proofWorkspaceContentMatches", value: readWorkspaceContentMatches(bytes) };
    case 21: {
      let reachable: boolean | undefined;
      decodeMessage(bytes, (number, wire, reader) => {
        if (number === 1) {
          if (reachable !== undefined) return invalid();
          reachable = boolValue(wire, reader);
        } else reader.skip(wire);
      });
      return { kind: "proofHealth", value: reachable ?? false };
    }
    case 22:
      return { kind: "proofWorkspaceGit", value: readWorkspaceGitResult(bytes) };
    case 23:
      return { kind: "proofTerminalReservation", value: readProofTerminalReservation(bytes) };
    case 24:
      return { kind: "proofAgentProxy", value: readProofAgentProxyStatus(bytes) };
    case 25:
      return { kind: "proofTerminalReplay", value: readProofTerminalReplay(bytes) };
    case 26:
      return { kind: "proofTerminalCwd", value: readProofTerminalCwd(bytes) };
    case 27:
      return { kind: "proofDeploymentHostResult", value: readDeploymentHostProbeResult(bytes) };
    case 29:
      return { kind: "proofPiVersion", value: readWorkspaceGitResult(bytes) };
    case 28:
      return { kind: "proofCodexVersion", value: readWorkspaceGitResult(bytes) };
    case 30:
      return { kind: "proofWorkspaceModeInspection", value: readWorkspaceModeInspection(bytes) };
    case 35:
      return { kind: "proofWorkspaceReadiness", value: readWorkspaceReadiness(bytes) };
    case 36:
      return { kind: "proofGuardedWriteStage", value: readGuardedWriteStage(bytes) };
    case 37:
      return { kind: "proofGuardedWriteResult", value: readGuardedWriteResult(bytes) };
    case 38: {
      // The only canonical encodings are one empty selected outcome.
      if (bytes.length !== 2 || bytes[1] !== 0) return invalid();
      if (bytes[0] === 0x0a) return { kind: "proofWorkspaceCreateResult", value: "created" };
      if (bytes[0] === 0x12) return { kind: "proofWorkspaceCreateResult", value: "alreadyExists" };
      return invalid();
    }
    case 39:
      return { kind: "proofWorkspaceEntryMutation", value: readWorkspaceEntryMutation(bytes) };
    case 40:
      return { kind: "proofWorkspaceWriteStage", value: readWorkspaceWriteStage(bytes) };
    case 41:
      return { kind: "proofThreadShell", value: readProofShellResult(bytes) };
    case 42:
      return { kind: "proofProviderShell", value: readProofShellResult(bytes) };
    case 43:
      return { kind: "proofAcpCommand", value: readProofAcpCommandResult(bytes) };
    case 44:
      return { kind: "proofAgentAction", value: readProofAgentActionResult(bytes) };
    case 45:
      return { kind: "proofPeerCoordinatorKey", value: readPeerCoordinatorKey(bytes) };
    case 46:
      return { kind: "proofPeerHostKey", value: readPeerHostKey(bytes) };
    case 49:
      return { kind: "proofAliases", value: readProofAliases(bytes) };
    case 34:
      return bytes.length === 0 ? { kind: "proofSyntheticPosixPasswordUnlocked" } : invalid();
    // C15 / W2 T-xfer: reserved transfer outcomes. Not enabled for real
    // transfers in S1-S4, so no product caller may accept one.
    case 47:
    case 48:
      return invalid();
    case 33:
      return { kind: "proofOpencode", value: readProofOpencode(bytes) };
    case 32:
      return { kind: "proofGitTrackedPush", value: readProofTrackedPushStatus(bytes) };
    case 31:
      return { kind: "proofWorkspaceModePublication", value: readWorkspaceModePublication(bytes) };
    default:
      return invalid();
  }
};
