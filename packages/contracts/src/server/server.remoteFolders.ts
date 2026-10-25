import { Schema } from "effect";

import { ExecutionTargetId, TrimmedNonEmptyString } from "../core/baseSchemas";

/** Lists folders on an SSH target over plain SSH, so it works before a remote agent exists. */
export const ServerListRemoteFoldersInput = Schema.Struct({
  executionTargetId: ExecutionTargetId,
  /** Absolute, `~`, or `~/…` path. Omitted means the remote home folder. */
  path: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))),
});
export type ServerListRemoteFoldersInput = typeof ServerListRemoteFoldersInput.Type;

export const ServerRemoteFolder = Schema.Struct({
  name: TrimmedNonEmptyString,
  isGitRepo: Schema.Boolean,
});
export type ServerRemoteFolder = typeof ServerRemoteFolder.Type;

export const ServerListRemoteFoldersResult = Schema.Struct({
  /** Resolved absolute path of the listed folder. */
  path: TrimmedNonEmptyString,
  homePath: TrimmedNonEmptyString,
  folders: Schema.Array(ServerRemoteFolder),
  truncated: Schema.Boolean,
});
export type ServerListRemoteFoldersResult = typeof ServerListRemoteFoldersResult.Type;

export class ServerListRemoteFoldersError extends Schema.TaggedErrorClass<ServerListRemoteFoldersError>()(
  "ServerListRemoteFoldersError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
