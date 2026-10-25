import { Schema } from "effect";
import { AuthKind, Bytes, Id, IssuedId, Lane, Role, U32, U64, Version } from "./primitives";
import {
  Generations,
  LaneBinding,
  Limits,
  ProfileIdentity,
  ReplacementBinding,
  RootIntent,
  Scope,
} from "./identity";

export const ClientHello = Schema.Struct({
  major: Version,
  minorMin: Version,
  minorMax: Version,
  profileDigest: Id,
  artifactSetDigest: Id,
  ownerEpoch: IssuedId,
  endpointInstance: IssuedId,
  role: Role,
  kind: AuthKind,
  credentialId: Id,
  lane: Lane,
  clientNonce: IssuedId,
  rootIntent: Schema.optionalKey(RootIntent),
  replacement: Schema.optionalKey(ReplacementBinding),
  laneBinding: Schema.optionalKey(LaneBinding),
});
export type ClientHello = typeof ClientHello.Type;
export const ChallengeFields = Schema.Struct({
  major: Version,
  minor: Version,
  profile: ProfileIdentity,
  artifactSetDigest: Id,
  ownerEpoch: IssuedId,
  endpointInstance: IssuedId,
  role: Role,
  kind: AuthKind,
  credentialId: Id,
  lane: Lane,
  clientNonce: IssuedId,
  ownerNonce: IssuedId,
  handshakeId: IssuedId,
  proposedSession: IssuedId,
  laneId: IssuedId,
  authorityRevision: U64,
  generations: Generations,
  ttlRemainingMs: U64,
  rootIntent: Schema.optionalKey(RootIntent),
  scope: Schema.optionalKey(Scope),
  scopeDigest: Id,
  limits: Limits,
  limitsDigest: Id,
  replacement: Schema.optionalKey(ReplacementBinding),
  laneBinding: Schema.optionalKey(LaneBinding),
});
export type ChallengeFields = typeof ChallengeFields.Type;
export const OwnerChallenge = Schema.Struct({ fields: ChallengeFields, ownerProof: Id });
export const ClientProof = Schema.Struct({
  handshakeId: IssuedId,
  transcript: Id,
  clientProof: Id,
});
export type ClientProof = typeof ClientProof.Type;
export const FinishFields = Schema.Struct({
  handshakeId: IssuedId,
  transcript: Id,
  sessionId: IssuedId,
  laneId: IssuedId,
  scopeDigest: Id,
  limitsDigest: Id,
  rootIntentDigest: Id,
});
export type FinishFields = typeof FinishFields.Type;
export const OwnerFinish = Schema.Struct({ fields: FinishFields, finishProof: Id });
export type OwnerFinish = typeof OwnerFinish.Type;
export const FinishAck = Schema.Struct({
  handshakeId: IssuedId,
  sessionId: IssuedId,
  finishDigest: Id,
  ackProof: Id,
});
export type FinishAck = typeof FinishAck.Type;
export const SessionReady = Schema.Struct({
  sessionId: IssuedId,
  transcript: Id,
  authorityRevision: U64,
  disposition: Schema.Literals([1, 2, 3, 4, 5]),
});
export const SessionFrameFields = Schema.Struct({
  sessionId: IssuedId,
  laneId: IssuedId,
  direction: Schema.Literals([1, 2]),
  sequence: U64,
  generations: Generations,
  scopeRevision: U64,
  kind: U32,
  body: Bytes,
});
export type SessionFrameFields = typeof SessionFrameFields.Type;
export const SessionFrame = Schema.Struct({ ...SessionFrameFields.fields, mac: Id });
export const AuthError = Schema.Struct({ code: Schema.Literals([1, 2]), retryAfterMs: U32 });
export const RootCommit = Schema.Struct({ intent: RootIntent, candidateSession: IssuedId });
export const CleanupRef = Schema.Struct({
  parentRootSequence: U64,
  shutdownId: IssuedId,
  class: Schema.Literals([1, 2, 3]),
  slot: U32,
  resourceIdentity: Id,
});
export type CleanupRef = typeof CleanupRef.Type;
export const CleanupOutcome = Schema.Struct({
  child: CleanupRef,
  childId: Id,
  mutationDigest: Id,
  state: Schema.Literals([1, 2, 3, 4, 5, 6, 7]),
  dispositionDigest: Id,
  resultCapsuleDigest: Schema.optionalKey(Id),
  authorityRevision: U64,
});
export type CleanupOutcome = typeof CleanupOutcome.Type;
export const CleanupGrantResult = Schema.Struct({
  outcome: CleanupOutcome,
  grantId: IssuedId,
  secret: Id,
  scope: Scope,
  scopeDigest: Id,
  ttlMs: Schema.Literal("30000"),
});
export type CleanupGrantResult = typeof CleanupGrantResult.Type;
