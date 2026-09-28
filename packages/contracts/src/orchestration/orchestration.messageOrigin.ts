import { Schema } from "effect";

import { ThreadId, TrimmedNonEmptyString } from "../core/baseSchemas";

export const MessageOriginKind = Schema.Literals([
  "crossThreadAgent",
  "initialDelegation",
  "handoff",
  "orchestraAssignment",
  "completionWatch",
  "ordinaryUser",
]);
export type MessageOriginKind = typeof MessageOriginKind.Type;

export const MessageOriginActor = Schema.Literals([
  "agent",
  "user",
  "userAssignment",
  "automation",
]);
export type MessageOriginActor = typeof MessageOriginActor.Type;

export const MessageOriginThread = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
});
export type MessageOriginThread = typeof MessageOriginThread.Type;

/** One attributed source segment. Keeping text per segment preserves attribution when queued prompts merge. */
export const MessageOriginSegment = Schema.Struct({
  kind: MessageOriginKind,
  actor: MessageOriginActor,
  text: Schema.String,
  sourceThreads: Schema.Array(MessageOriginThread),
  verified: Schema.Boolean,
});
export type MessageOriginSegment = typeof MessageOriginSegment.Type;

/** Narrow public hint; the server must verify lineage before persisting it. */
export const ClientOrchestraAssignmentOrigin = Schema.Struct({
  kind: Schema.Literal("orchestraAssignment"),
  actor: Schema.Literal("userAssignment"),
  text: Schema.String,
  sourceThreads: Schema.Array(MessageOriginThread),
  verified: Schema.Literal(false),
});
