import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import type {
  OrchestrationMessage,
  OrchestrationThread,
} from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { ModelSelection } from "@bigbud/contracts/orchestration/orchestration.provider";
import { NonNegativeInt, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { ChatAttachment } from "@bigbud/contracts/orchestration/orchestration.attachments.ts";

import { resolveWorkspaceExecutionTargetId } from "../../workspace-target/workspaceTarget.ts";
import { metadataFingerprint } from "./ThreadMetadataGeneration.policy.ts";

/** Only opaque configuration/account identities belong here; provider settings stay in memory. */
export const MetadataCapturedPath = Schema.Struct({
  selection: ModelSelection,
  transport: Schema.String,
  accountIdentity: Schema.String,
  nativeAccountIdentity: Schema.optionalKey(Schema.String),
  executionTarget: Schema.String,
  promptVersion: Schema.String,
  validatorVersion: Schema.String,
  mode: Schema.Literal("auxiliary"),
});
export type MetadataCapturedPath = typeof MetadataCapturedPath.Type;

const common = {
  version: Schema.Literal(1),
  threadId: ThreadId,
  expectedRevision: NonNegativeInt,
  configEpoch: Schema.String,
  configuredPrimary: Schema.Boolean,
  primaryPath: Schema.NullOr(MetadataCapturedPath),
  threadPath: Schema.NullOr(MetadataCapturedPath),
  workspace: Schema.Struct({
    projectId: ProjectId,
    worktreePath: Schema.NullOr(Schema.String),
    branch: Schema.NullOr(Schema.String),
    executionTarget: Schema.String,
    cwd: Schema.String,
  }),
  source: Schema.Struct({
    prefixLength: NonNegativeInt,
    frontier: NonNegativeInt,
    digest: Schema.String,
  }),
};

export const MetadataTitleContext = Schema.Struct({
  ...common,
  operation: Schema.Literal("title"),
  initialTitle: Schema.String,
  titleSeed: Schema.String,
  message: Schema.String,
  attachments: Schema.Array(ChatAttachment),
});
export const MetadataSummaryContext = Schema.Struct({
  ...common,
  operation: Schema.Literal("summary"),
  previousSummary: Schema.NullOr(Schema.String),
  previousMessageCount: NonNegativeInt,
  transcript: Schema.String,
});
export const MetadataCapturedContext = Schema.Union([MetadataTitleContext, MetadataSummaryContext]);
export type MetadataCapturedContext = typeof MetadataCapturedContext.Type;
export type MetadataTitleContext = typeof MetadataTitleContext.Type;
export type MetadataSummaryContext = typeof MetadataSummaryContext.Type;
export type MetadataCaptureOptions = Pick<
  MetadataCapturedContext,
  "expectedRevision" | "configEpoch" | "configuredPrimary" | "primaryPath" | "threadPath"
> & { readonly cwd: string };

export const decodeMetadataContext = (json: string) =>
  Schema.decodeEffect(Schema.fromJsonString(MetadataCapturedContext))(json, {
    onExcessProperty: "error",
  });

/** Hash text incrementally; do not stringify an entire potentially enormous conversation. */
export function metadataSourceDigest(messages: ReadonlyArray<OrchestrationMessage>): string {
  const hash = createHash("sha256");
  for (const message of messages) {
    for (const part of [
      message.id,
      message.role,
      message.text,
      metadataFingerprint(message.attachments ?? []),
    ]) {
      hash.update(`${Buffer.byteLength(part)}:`);
      hash.update(part);
    }
  }
  return hash.digest("hex");
}

export function captureMetadataBase(thread: OrchestrationThread, options: MetadataCaptureOptions) {
  return {
    version: 1 as const,
    threadId: thread.id,
    expectedRevision: options.expectedRevision,
    configEpoch: options.configEpoch,
    configuredPrimary: options.configuredPrimary,
    primaryPath: structuredClone(options.primaryPath),
    threadPath: structuredClone(options.threadPath),
    workspace: {
      projectId: thread.projectId,
      worktreePath: thread.worktreePath,
      branch: thread.branch,
      executionTarget: resolveWorkspaceExecutionTargetId(thread),
      cwd: options.cwd,
    },
    source: {
      prefixLength: thread.messages.length,
      frontier: thread.messages.filter((m) => m.role === "user" || m.role === "assistant").length,
      digest: metadataSourceDigest(thread.messages),
    },
  };
}

export function metadataSourceIsCurrent(
  context: MetadataCapturedContext,
  thread: OrchestrationThread,
  revision: number,
  cwd: string,
): boolean {
  return (
    thread.id === context.threadId &&
    !thread.archivedAt &&
    !thread.deletingAt &&
    !thread.deletedAt &&
    revision === context.expectedRevision &&
    cwd === context.workspace.cwd &&
    thread.projectId === context.workspace.projectId &&
    thread.worktreePath === context.workspace.worktreePath &&
    thread.branch === context.workspace.branch &&
    resolveWorkspaceExecutionTargetId(thread) === context.workspace.executionTarget &&
    thread.messages.length >= context.source.prefixLength &&
    metadataSourceDigest(thread.messages.slice(0, context.source.prefixLength)) ===
      context.source.digest
  );
}
