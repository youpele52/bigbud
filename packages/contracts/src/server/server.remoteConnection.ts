import { Schema } from "effect";

import { ExecutionTargetId, TrimmedNonEmptyString } from "../core/baseSchemas";

/** Identifies the SSH execution target whose local connection the user disconnects or connects. */
export const ServerRemoteConnectionInput = Schema.Struct({
  executionTargetId: ExecutionTargetId,
});
export type ServerRemoteConnectionInput = typeof ServerRemoteConnectionInput.Type;

export const ServerRemoteConnectionResult = Schema.Struct({
  executionTargetId: ExecutionTargetId,
  /** True while the user-initiated disconnect is in effect for the target. */
  disconnected: Schema.Boolean,
});
export type ServerRemoteConnectionResult = typeof ServerRemoteConnectionResult.Type;

export const ServerListDisconnectedExecutionTargetsInput = Schema.Struct({});
export type ServerListDisconnectedExecutionTargetsInput =
  typeof ServerListDisconnectedExecutionTargetsInput.Type;

export const ServerListDisconnectedExecutionTargetsResult = Schema.Struct({
  executionTargetIds: Schema.Array(ExecutionTargetId),
});
export type ServerListDisconnectedExecutionTargetsResult =
  typeof ServerListDisconnectedExecutionTargetsResult.Type;

export class ServerRemoteConnectionError extends Schema.TaggedErrorClass<ServerRemoteConnectionError>()(
  "ServerRemoteConnectionError",
  { message: TrimmedNonEmptyString, cause: Schema.optional(Schema.Defect) },
) {}
