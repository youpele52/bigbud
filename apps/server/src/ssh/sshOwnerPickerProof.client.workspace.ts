import { randomUUID } from "node:crypto";

import type {
  WorkspaceModeSshOwner,
  WorkspaceModeSshPublishOutcome,
} from "../remote-backend/workspaceMode.ssh.owner.ts";
import type {
  PickerProofWorkspaceGitInput,
  PickerProofWorkspaceGitResult,
} from "./sshOwnerPickerProof.codec.git.ts";
import {
  withPickerReadCancellation,
  type SendPickerCancel,
} from "./sshOwnerPickerProof.client.list.ts";
import type { PickerProofOperation } from "./sshOwnerPickerProof.codec.ts";
import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import type { PickerProofWorkspaceReadiness } from "./sshOwnerPickerProof.codec.readiness.ts";
import { invalid, PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";
import {
  clampWorkspaceContentSearchLimit,
  isWorkspaceWriteContents,
  MAX_WORKSPACE_WRITE_BYTES,
  type PickerProofWorkspaceContentMatches,
  type PickerProofWorkspaceContentSearchInput,
  type PickerProofWorkspaceDirectory,
  type PickerProofWorkspaceFile,
  type PickerProofWorkspaceIndex,
  type PickerProofWorkspaceIndexInput,
  type PickerProofWorkspaceListInput,
  type PickerProofWorkspaceReadInput,
  type PickerProofWorkspaceWriteInput,
} from "./sshOwnerPickerProof.codec.workspace.ts";
import {
  MAX_WORKSPACE_STAGED_WRITE_BYTES,
  MAX_WORKSPACE_WRITE_CHUNK_BYTES,
  type ProofWorkspaceWriteBinding,
} from "./sshOwnerPickerProof.codec.workspace.mutation.ts";

import type { ProofWorkspaceModeInspection } from "./sshOwnerPickerProof.codec.workspaceMode.ts";
import {
  makeWorkspaceEntryClient,
  type PickerProofWorkspaceEntryClient,
} from "./sshOwnerPickerProof.client.workspaceEntry.ts";
import {
  prepareGuardedWriteForProof,
  validateGuardedWriteForProof,
} from "./sshOwnerPickerProof.guardedWriteStage.ts";
import type {
  GuardedWriteBinding,
  GuardedWriteOperation,
  GuardedWriteResult,
} from "./sshOwnerPickerProof.codec.guardedWrite.ts";

type GuardedWriteInput = Parameters<typeof prepareGuardedWriteForProof>[1] & {
  readonly executionTargetId: string;
};

type PickerProofWorkspaceEntryInput = {
  readonly executionTargetId: string;
  readonly workspaceRoot: string;
  readonly relativePath: string;
};

export interface PickerProofWorkspaceClient extends PickerProofWorkspaceEntryClient {
  inspectProofWorkspaceMode(input: {
    readonly executionTargetId: string;
    readonly root: string;
  }): Promise<ProofWorkspaceModeInspection>;
  publishProofWorkspaceMode(
    request: Parameters<WorkspaceModeSshOwner["publishWorkspaceMode"]>[0],
  ): Promise<WorkspaceModeSshPublishOutcome>;
  readProofWorkspaceFile(
    input: PickerProofWorkspaceReadInput,
    signal?: AbortSignal,
  ): Promise<PickerProofWorkspaceFile>;
  listProofWorkspaceDirectory(
    input: PickerProofWorkspaceListInput,
    signal?: AbortSignal,
  ): Promise<PickerProofWorkspaceDirectory>;
  snapshotProofWorkspaceDirectory(
    input: PickerProofWorkspaceListInput,
    signal?: AbortSignal,
  ): Promise<string>;
  probeProofWorkspaceReadiness(
    input: PickerProofWorkspaceIndexInput,
  ): Promise<PickerProofWorkspaceReadiness>;
  indexProofWorkspace(input: PickerProofWorkspaceIndexInput): Promise<PickerProofWorkspaceIndex>;
  searchProofWorkspaceContents(
    input: PickerProofWorkspaceContentSearchInput,
    signal?: AbortSignal,
  ): Promise<PickerProofWorkspaceContentMatches>;
  createProofWorkspaceFile(
    input: PickerProofWorkspaceWriteInput,
  ): Promise<"created" | "alreadyExists">;
  createProofWorkspaceDirectory(
    input: PickerProofWorkspaceEntryInput,
  ): Promise<"created" | "alreadyExists">;
  deleteProofWorkspaceEntry(
    input: PickerProofWorkspaceEntryInput & { readonly expectedDirectory: boolean },
  ): Promise<"deleted" | "notFound">;
  writeProofWorkspaceFile(input: PickerProofWorkspaceWriteInput): Promise<void>;
  validateProofGuardedWrite(
    input: GuardedWriteInput,
    signal?: AbortSignal,
  ): ReturnType<typeof validateGuardedWriteForProof>;
  applyProofGuardedWrite(
    input: GuardedWriteInput,
    beforeApply: (binding: GuardedWriteBinding) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<GuardedWriteResult>;
  executeProofWorkspaceGit(
    input: PickerProofWorkspaceGitInput,
  ): Promise<PickerProofWorkspaceGitResult>;
}

export function makePickerProofWorkspaceClient(
  /** The exact runtime target, or a predicate for a production bound target. */
  target: string | ((executionTargetId: string) => boolean),
  execute: (
    operation: PickerProofOperation,
    beforeDispatch?: (id: Uint8Array) => void,
  ) => Promise<Exclude<Outcome, { kind: "error" }>>,
  sendCancel?: SendPickerCancel,
): PickerProofWorkspaceClient {
  const serves = typeof target === "string" ? (id: string) => id === target : target;
  function requireTarget(input: { readonly executionTargetId: string }) {
    if (typeof input !== "object" || input === null || !serves(input.executionTargetId))
      throw new PickerProofOwnerError("invalidOperands");
  }

  async function executeStage(operation: GuardedWriteOperation) {
    const outcome = await execute(operation);
    return outcome.kind === "proofGuardedWriteStage" ? outcome.value : invalid();
  }

  // A signal without a bound private cancel capability still prevents a queued
  // dispatch; it never launches a second SSH command.
  async function executeAtSignal(signal: AbortSignal | undefined, operation: PickerProofOperation) {
    signal?.throwIfAborted();
    return execute(operation);
  }

  return {
    async inspectProofWorkspaceMode(input) {
      requireTarget(input);
      const outcome = await execute({ kind: "proofWorkspaceModeInspect", root: input.root });
      return outcome.kind === "proofWorkspaceModeInspection" ? outcome.value : invalid();
    },
    async publishProofWorkspaceMode({ observation, nextRecord }) {
      requireTarget(observation);
      if (!observation.publicationToken) throw new PickerProofOwnerError("operationDenied");
      const outcome = await execute({
        kind: "proofWorkspaceModePublish",
        root: observation.workspaceRoot,
        publicationToken: Uint8Array.from(observation.publicationToken),
        nextRecord,
      });
      return outcome.kind === "proofWorkspaceModePublication" ? outcome.value : invalid();
    },
    async readProofWorkspaceFile(input, signal) {
      requireTarget(input);
      const { workspaceRoot, relativePath, kind } = input;
      const read =
        kind === "range" ? { kind, offset: input.offset, maxBytes: input.maxBytes } : { kind };
      const request = { kind: "proofWorkspaceRead", workspaceRoot, relativePath, read } as const;
      const outcome =
        signal && sendCancel
          ? await withPickerReadCancellation(
              signal,
              sendCancel,
              "listCancelled",
              (beforeDispatch) => execute(request, beforeDispatch),
            )
          : await executeAtSignal(signal, request);
      return outcome.kind === "proofWorkspaceFile" ? outcome.value : invalid();
    },
    async listProofWorkspaceDirectory(input, signal) {
      requireTarget(input);
      const { workspaceRoot, relativeDir } = input;
      const request = { kind: "proofWorkspaceList", workspaceRoot, relativeDir } as const;
      const outcome =
        signal && sendCancel
          ? await withPickerReadCancellation(
              signal,
              sendCancel,
              "listCancelled",
              (beforeDispatch) => execute(request, beforeDispatch),
            )
          : await executeAtSignal(signal, request);
      return outcome.kind === "proofWorkspaceDirectory" ? outcome.value : invalid();
    },
    async snapshotProofWorkspaceDirectory(input, signal) {
      requireTarget(input);
      const { workspaceRoot, relativeDir } = input;
      const request = { kind: "proofWorkspaceSnapshot", workspaceRoot, relativeDir } as const;
      signal?.throwIfAborted();
      const outcome =
        signal && sendCancel
          ? await withPickerReadCancellation(
              signal,
              sendCancel,
              "listCancelled",
              (beforeDispatch) => execute(request, beforeDispatch),
            )
          : await execute(request);
      return outcome.kind === "proofWorkspaceSnapshot" ? outcome.value : invalid();
    },
    async probeProofWorkspaceReadiness(input) {
      requireTarget(input);
      const outcome = await execute({
        kind: "proofWorkspaceReadiness",
        workspaceRoot: input.workspaceRoot,
      });
      return outcome.kind === "proofWorkspaceReadiness" ? outcome.value : invalid();
    },
    async indexProofWorkspace(input) {
      requireTarget(input);
      const { workspaceRoot } = input;
      const outcome = await execute({ kind: "proofWorkspaceIndex", workspaceRoot });
      return outcome.kind === "proofWorkspaceIndex" ? outcome.value : invalid();
    },
    async searchProofWorkspaceContents(input, signal) {
      requireTarget(input);
      const { workspaceRoot, query, limit } = input;
      const request = {
        kind: "proofWorkspaceContentSearch",
        workspaceRoot,
        query,
        limit: clampWorkspaceContentSearchLimit(limit),
      } as const;
      const outcome =
        signal && sendCancel
          ? await withPickerReadCancellation(
              signal,
              sendCancel,
              "listCancelled",
              (beforeDispatch) => execute(request, beforeDispatch),
            )
          : await executeAtSignal(signal, request);
      return outcome.kind === "proofWorkspaceContentMatches" ? outcome.value : invalid();
    },
    ...makeWorkspaceEntryClient(requireTarget, (operation) => execute(operation)),
    async validateProofGuardedWrite(input, signal) {
      requireTarget(input);
      return validateGuardedWriteForProof(executeStage, input, signal);
    },
    async applyProofGuardedWrite(input, beforeApply, signal) {
      requireTarget(input);
      const { binding, lease } = await prepareGuardedWriteForProof(executeStage, input, signal);
      try {
        await beforeApply(binding);
        signal?.throwIfAborted();
      } catch (cause) {
        await executeStage({ kind: "proofGuardedWriteAbort", binding, lease }).catch(
          () => undefined,
        );
        throw cause;
      }
      const outcome = await execute({ kind: "proofGuardedWriteApply", binding, lease });
      if (outcome.kind !== "proofGuardedWriteResult") return invalid();
      if (
        outcome.value.kind === "saved" &&
        outcome.value.resultSha256 !== Buffer.from(binding.attemptedSha256).toString("hex")
      )
        return invalid();
      return outcome.value;
    },
    async createProofWorkspaceFile(input) {
      requireTarget(input);
      const { workspaceRoot, relativePath, contents } = input;
      if (!isWorkspaceWriteContents(contents)) throw new PickerProofOwnerError("invalidOperands");
      const outcome = await execute({
        kind: "proofWorkspaceCreate",
        workspaceRoot,
        relativePath,
        contents: new Uint8Array(contents),
      });
      return outcome.kind === "proofWorkspaceCreateResult" ? outcome.value : invalid();
    },
    async createProofWorkspaceDirectory(input) {
      requireTarget(input);
      const { workspaceRoot, relativePath } = input;
      const outcome = await execute({
        kind: "proofWorkspaceCreateDirectory",
        workspaceRoot,
        relativePath,
      });
      if (outcome.kind !== "proofWorkspaceEntryMutation") return invalid();
      if (outcome.value === "created" || outcome.value === "alreadyExists") return outcome.value;
      return invalid();
    },
    async deleteProofWorkspaceEntry(input) {
      requireTarget(input);
      const { workspaceRoot, relativePath, expectedDirectory } = input;
      const outcome = await execute({
        kind: "proofWorkspaceDeleteEntry",
        workspaceRoot,
        relativePath,
        expectedDirectory,
      });
      if (outcome.kind !== "proofWorkspaceEntryMutation") return invalid();
      if (outcome.value === "deleted" || outcome.value === "notFound") return outcome.value;
      return invalid();
    },
    async writeProofWorkspaceFile(input) {
      requireTarget(input);
      const { workspaceRoot, relativePath, contents } = input;
      if (contents.byteLength > MAX_WORKSPACE_STAGED_WRITE_BYTES)
        throw new PickerProofOwnerError("invalidOperands");
      if (contents.byteLength <= MAX_WORKSPACE_WRITE_BYTES) {
        if (!isWorkspaceWriteContents(contents)) throw new PickerProofOwnerError("invalidOperands");
        const outcome = await execute({
          kind: "proofWorkspaceWrite",
          workspaceRoot,
          relativePath,
          // Bind both grant and execution to one copy even if the caller mutates its buffer.
          contents: new Uint8Array(contents),
        });
        if (outcome.kind !== "proofWorkspaceWritten") return invalid();
        return;
      }
      const binding: ProofWorkspaceWriteBinding = {
        operationId: randomUUID(),
        workspaceRoot,
        relativePath,
        bodyBytes: contents.byteLength,
      };
      const begun = await execute({ kind: "proofWorkspaceWriteBegin", binding });
      if (begun.kind !== "proofWorkspaceWriteStage" || begun.value.kind !== "begun")
        return invalid();
      const lease = begun.value.lease;
      let offset = 0;
      try {
        while (offset < contents.byteLength) {
          const end = Math.min(offset + MAX_WORKSPACE_WRITE_CHUNK_BYTES, contents.byteLength);
          const data = new Uint8Array(contents.subarray(offset, end));
          const chunk = await execute({
            kind: "proofWorkspaceWriteChunk",
            binding,
            lease,
            offset,
            data,
          });
          if (
            chunk.kind !== "proofWorkspaceWriteStage" ||
            chunk.value.kind !== "chunkAccepted" ||
            chunk.value.nextOffset !== end
          )
            return invalid();
          offset = end;
        }
      } catch (cause) {
        await execute({ kind: "proofWorkspaceWriteAbort", binding, lease }).catch(() => undefined);
        throw cause;
      }
      // Once COMMIT is dispatched a lost reply is unknown; never abort or replay it.
      const committed = await execute({ kind: "proofWorkspaceWriteCommit", binding, lease });
      if (committed.kind !== "proofWorkspaceWriteStage" || committed.value.kind !== "written")
        return invalid();
    },
    async executeProofWorkspaceGit(input) {
      requireTarget(input);
      const { executionTargetId: _target, ...operands } = input;
      const outcome = await execute({ kind: "proofWorkspaceGit", ...operands });
      return outcome.kind === "proofWorkspaceGit" ? outcome.value : invalid();
    },
  };
}
