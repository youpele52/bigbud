import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../core/baseSchemas";
import { ServerStalledPayload } from "./connectionDiagnostics";

export const ServerLifecycleReadyPayload = Schema.Struct({
  at: IsoDateTime,
});
export type ServerLifecycleReadyPayload = typeof ServerLifecycleReadyPayload.Type;

export const ServerLifecycleWelcomePayload = Schema.Struct({
  serverRunId: Schema.optional(TrimmedNonEmptyString),
  cwd: TrimmedNonEmptyString,
  projectName: TrimmedNonEmptyString,
  bootstrapProjectId: Schema.optional(ProjectId),
  bootstrapThreadId: Schema.optional(ThreadId),
  defaultChatCwd: Schema.optional(TrimmedNonEmptyString),
});
export type ServerLifecycleWelcomePayload = typeof ServerLifecycleWelcomePayload.Type;

export const ServerLifecycleStreamWelcomeEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("welcome"),
  payload: ServerLifecycleWelcomePayload,
});
export type ServerLifecycleStreamWelcomeEvent = typeof ServerLifecycleStreamWelcomeEvent.Type;

export const ServerLifecycleStreamReadyEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("ready"),
  payload: ServerLifecycleReadyPayload,
});
export type ServerLifecycleStreamReadyEvent = typeof ServerLifecycleStreamReadyEvent.Type;

/**
 * Published after the server's event loop was blocked for at least
 * `SERVER_STALL_THRESHOLD_MS`. A stall is reported when it ends, because a
 * blocked loop cannot send anything while it lasts.
 */
export const ServerLifecycleStreamStalledEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("stalled"),
  payload: ServerStalledPayload,
});
export type ServerLifecycleStreamStalledEvent = typeof ServerLifecycleStreamStalledEvent.Type;

export const ServerLifecycleStreamEvent = Schema.Union([
  ServerLifecycleStreamWelcomeEvent,
  ServerLifecycleStreamReadyEvent,
  ServerLifecycleStreamStalledEvent,
]);
export type ServerLifecycleStreamEvent = typeof ServerLifecycleStreamEvent.Type;
