import * as Schema from "effect/Schema";
import { ExecutionTargetId, TrimmedNonEmptyString } from "../core/baseSchemas";
import { TerminalOpenInput, TerminalSnapshotInput } from "./terminal";

const Identity = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export const TerminalRemoteInventoryInput = Schema.Struct({
  executionTargetId: ExecutionTargetId,
  after: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
});
export type TerminalRemoteInventoryInput = typeof TerminalRemoteInventoryInput.Type;

export const TerminalRemoteSession = Schema.Struct({
  threadId: Identity,
  terminalId: Identity,
  executionTargetId: ExecutionTargetId,
  resourceId: Identity,
  generation: Identity,
  epoch: Identity,
  cwd: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  status: Schema.Literals(["running", "stopped", "unknown"]),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  pid: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type TerminalRemoteSession = typeof TerminalRemoteSession.Type;
export const TerminalRemoteInventory = Schema.Struct({
  sessions: Schema.Array(TerminalRemoteSession).check(Schema.isMaxLength(100)),
  nextCursor: Schema.String.check(Schema.isMaxLength(256)),
});
export type TerminalRemoteInventory = typeof TerminalRemoteInventory.Type;

/** The observed resource ID fences replacement races; attachment never creates a terminal. */
export const TerminalRemoteAttachInput = Schema.Struct({
  ...TerminalOpenInput.fields,
  executionTargetId: ExecutionTargetId,
  resourceId: Identity,
});
export type TerminalRemoteAttachInput = typeof TerminalRemoteAttachInput.Encoded;

export const TerminalRemoteDetachInput = Schema.Struct({
  ...TerminalSnapshotInput.fields,
  expectedGeneration: Identity,
});
export type TerminalRemoteDetachInput = typeof TerminalRemoteDetachInput.Encoded;
