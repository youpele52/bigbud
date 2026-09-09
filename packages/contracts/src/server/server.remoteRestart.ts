import { Schema } from "effect";

import { ExecutionTargetId, ProjectId, TrimmedNonEmptyString } from "../core/baseSchemas";

export const ServerRestartRemoteAgentInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  projectId: ProjectId,
  expectedWorkspaceExecutionTargetId: ExecutionTargetId,
});
export type ServerRestartRemoteAgentInput = typeof ServerRestartRemoteAgentInput.Type;

export const ServerGetRemoteAgentRestartStatusInput = ServerRestartRemoteAgentInput;
export type ServerGetRemoteAgentRestartStatusInput =
  typeof ServerGetRemoteAgentRestartStatusInput.Type;

export const ServerRemoteRestartPhase = Schema.Literals([
  "prepared",
  "stopping",
  "stopped",
  "starting",
  "ready",
  "failed",
  "unknown",
]);
export type ServerRemoteRestartPhase = typeof ServerRemoteRestartPhase.Type;

export const ServerRestartRemoteAgentResult = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  projectId: ProjectId,
  executionTargetId: ExecutionTargetId,
  phase: ServerRemoteRestartPhase,
  message: TrimmedNonEmptyString,
  oldEpoch: Schema.optional(TrimmedNonEmptyString),
  replacementEpoch: Schema.optional(TrimmedNonEmptyString),
});
export type ServerRestartRemoteAgentResult = typeof ServerRestartRemoteAgentResult.Type;

export class ServerRestartRemoteAgentError extends Schema.TaggedErrorClass<ServerRestartRemoteAgentError>()(
  "ServerRestartRemoteAgentError",
  { message: TrimmedNonEmptyString, cause: Schema.optional(Schema.Defect) },
) {}
