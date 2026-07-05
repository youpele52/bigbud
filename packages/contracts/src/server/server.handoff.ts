import { Schema } from "effect";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "../core/baseSchemas";

export const ServerHandoffJobId = TrimmedNonEmptyString;
export type ServerHandoffJobId = typeof ServerHandoffJobId.Type;

export const ServerHandoffJobStatus = Schema.Literals(["queued", "running", "succeeded", "failed"]);
export type ServerHandoffJobStatus = typeof ServerHandoffJobStatus.Type;

export const ServerHandoffJob = Schema.Struct({
  jobId: ServerHandoffJobId,
  threadId: ThreadId,
  status: ServerHandoffJobStatus,
  title: TrimmedNonEmptyString,
  focus: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  outputPath: Schema.NullOr(TrimmedNonEmptyString),
  error: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerHandoffJob = typeof ServerHandoffJob.Type;

export const ServerStartHandoffJobInput = Schema.Struct({
  threadId: ThreadId,
  focus: Schema.optional(TrimmedNonEmptyString),
});
export type ServerStartHandoffJobInput = typeof ServerStartHandoffJobInput.Type;

export const ServerGetHandoffJobInput = Schema.Struct({
  jobId: ServerHandoffJobId,
});
export type ServerGetHandoffJobInput = typeof ServerGetHandoffJobInput.Type;

export class ServerHandoffJobError extends Schema.TaggedErrorClass<ServerHandoffJobError>()(
  "ServerHandoffJobError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
