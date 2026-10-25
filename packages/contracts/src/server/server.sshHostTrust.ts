import { Schema } from "effect";

import { ExecutionTargetId, TrimmedNonEmptyString } from "../core/baseSchemas";

export const SshHostTrustChallenge = Schema.Struct({
  challengeId: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  keyType: TrimmedNonEmptyString,
  fingerprint: TrimmedNonEmptyString,
});
export type SshHostTrustChallenge = typeof SshHostTrustChallenge.Type;

export const ServerTrustSshHostInput = Schema.Struct({
  executionTargetId: ExecutionTargetId,
  challengeId: TrimmedNonEmptyString,
});
export type ServerTrustSshHostInput = typeof ServerTrustSshHostInput.Type;

export const ServerTrustSshHostResult = Schema.Struct({ message: TrimmedNonEmptyString });
export type ServerTrustSshHostResult = typeof ServerTrustSshHostResult.Type;

export class ServerTrustSshHostError extends Schema.TaggedErrorClass<ServerTrustSshHostError>()(
  "ServerTrustSshHostError",
  { message: TrimmedNonEmptyString, cause: Schema.optional(Schema.Defect) },
) {}
