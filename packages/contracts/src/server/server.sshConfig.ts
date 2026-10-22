import { Schema } from "effect";

import { NonNegativeInt, TrimmedNonEmptyString } from "../core/baseSchemas";

export const ServerListSshConfigHostsInput = Schema.Struct({});
export type ServerListSshConfigHostsInput = typeof ServerListSshConfigHostsInput.Type;

/** A concrete `Host` alias. Hints are literal values from its own block, for display only. */
export const ServerSshConfigHost = Schema.Struct({
  alias: TrimmedNonEmptyString,
  sourcePath: TrimmedNonEmptyString,
  line: NonNegativeInt,
  hostName: Schema.optional(TrimmedNonEmptyString),
  user: Schema.optional(TrimmedNonEmptyString),
  port: Schema.optional(TrimmedNonEmptyString),
});
export type ServerSshConfigHost = typeof ServerSshConfigHost.Type;

export const ServerSshConfigSource = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: Schema.Literals(["user", "system", "include"]),
  status: Schema.Literals(["loaded", "missing", "error", "skipped"]),
  message: Schema.optional(TrimmedNonEmptyString),
});
export type ServerSshConfigSource = typeof ServerSshConfigSource.Type;

export const ServerListSshConfigHostsResult = Schema.Struct({
  /** Machine whose SSH config was read; this is where bigbud runs `ssh`. */
  machineName: TrimmedNonEmptyString,
  hosts: Schema.Array(ServerSshConfigHost),
  sources: Schema.Array(ServerSshConfigSource),
});
export type ServerListSshConfigHostsResult = typeof ServerListSshConfigHostsResult.Type;

export class ServerListSshConfigHostsError extends Schema.TaggedErrorClass<ServerListSshConfigHostsError>()(
  "ServerListSshConfigHostsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
