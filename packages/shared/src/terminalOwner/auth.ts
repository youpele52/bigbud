import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  ChallengeFields,
  ClientHello,
  FinishFields,
  OwnerFinish,
  SessionFrameFields,
  FinishAck,
} from "@bigbud/contracts/terminal-owner/auth";
import type {
  ProfileIdentity,
  Scope,
  ProcessIdentity,
  Generations,
} from "@bigbud/contracts/terminal-owner/identity";
import { canonicalDomain, encodeCanonical, type CanonicalRecord } from "./canonical";
import { equalBytes, zeroId } from "./canonical.validation";
import { requireContract } from "./errors";
import { OwnerShutdownInventoryModel } from "./shutdownInventory.model";
import type { OwnerShutdownInventory } from "@bigbud/contracts/terminal-owner/shutdown";

export function sha256(...parts: readonly Uint8Array[]): Uint8Array {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return Uint8Array.from(hash.digest());
}
/** Standard Node HMAC, also used for RFC 4231 vectors; protocol callers require 32-byte keys. */
export function hmacSha256(key: Uint8Array, ...parts: readonly Uint8Array[]): Uint8Array {
  const mac = createHmac("sha256", key);
  for (const part of parts) mac.update(part);
  return Uint8Array.from(mac.digest());
}
export function verifyTag(expected: Uint8Array, actual: Uint8Array): boolean {
  return expected.length === 32 && actual.length === 32 && timingSafeEqual(expected, actual);
}
export function recordDigest(
  name: "ProfileIdentity" | "Scope" | "Limits" | "RootIntent",
  value: unknown,
): Uint8Array {
  const domain = {
    ProfileIdentity: "profile/v1",
    Scope: "scope/v1.1",
    Limits: "limits/v1",
    RootIntent: "root-intent/v1",
  }[name];
  return sha256(canonicalDomain(domain), encodeCanonical(name, value));
}
function key32(key: Uint8Array) {
  requireContract(key.length === 32, "AUTH_FAILED");
}
export function deriveRootAuthKey(
  profileKey: Uint8Array,
  profileDigest: Uint8Array,
  ownerEpoch: Uint8Array,
  artifactSetDigest: Uint8Array,
): Uint8Array {
  key32(profileKey);
  [profileDigest, ownerEpoch, artifactSetDigest].forEach(key32);
  return hmacSha256(
    profileKey,
    canonicalDomain("bigbud/terminal-owner/root-auth/v1"),
    profileDigest,
    ownerEpoch,
    artifactSetDigest,
  );
}
export function transcriptDigest(hello: ClientHello, fields: ChallengeFields): Uint8Array {
  return sha256(
    canonicalDomain("bigbud/terminal-owner/auth/v1.1"),
    encodeCanonical("ClientHello", hello),
    encodeCanonical("ChallengeFields", fields),
  );
}
export function transcriptProof(
  key: Uint8Array,
  direction: "owner-proof" | "client-proof",
  transcript: Uint8Array,
): Uint8Array {
  key32(key);
  key32(transcript);
  return hmacSha256(key, canonicalDomain(direction), transcript);
}
export function finishFields(fields: ChallengeFields, transcript: Uint8Array): FinishFields {
  return {
    handshakeId: fields.handshakeId.slice(),
    transcript: transcript.slice(),
    sessionId: fields.proposedSession.slice(),
    laneId: fields.laneId.slice(),
    scopeDigest: fields.scopeDigest.slice(),
    limitsDigest: fields.limitsDigest.slice(),
    rootIntentDigest: fields.rootIntent ? recordDigest("RootIntent", fields.rootIntent) : zeroId(),
  };
}
export function ownerFinish(key: Uint8Array, fields: FinishFields): OwnerFinish {
  key32(key);
  return {
    fields: structuredClone(fields),
    finishProof: hmacSha256(
      key,
      canonicalDomain("owner-finish"),
      encodeCanonical("FinishFields", fields),
    ),
  };
}
export function finishAck(key: Uint8Array, finish: OwnerFinish): FinishAck {
  key32(key);
  const finishDigest = sha256(canonicalDomain("finish/v1"), encodeCanonical("OwnerFinish", finish));
  return {
    handshakeId: finish.fields.handshakeId.slice(),
    sessionId: finish.fields.sessionId.slice(),
    finishDigest,
    ackProof: hmacSha256(
      key,
      canonicalDomain("finish-ack"),
      finish.fields.handshakeId,
      finish.fields.sessionId,
      finishDigest,
    ),
  };
}
export function sessionKeys(
  key: Uint8Array,
  transcript: Uint8Array,
  sessionId: Uint8Array,
  laneId: Uint8Array,
) {
  key32(key);
  [transcript, sessionId, laneId].forEach(key32);
  return {
    clientToOwner: hmacSha256(
      key,
      canonicalDomain("session-key/c2o"),
      transcript,
      sessionId,
      laneId,
    ),
    ownerToClient: hmacSha256(
      key,
      canonicalDomain("session-key/o2c"),
      transcript,
      sessionId,
      laneId,
    ),
  };
}
export function sessionFrameTag(key: Uint8Array, frame: SessionFrameFields): Uint8Array {
  key32(key);
  return hmacSha256(key, canonicalDomain("frame/v1"), encodeCanonical("SessionFrameFields", frame));
}
export function verifySessionFrame(
  key: Uint8Array,
  frame: SessionFrameFields,
  tag: Uint8Array,
  expected: Omit<SessionFrameFields, "kind" | "body">,
): boolean {
  // Header fences never advance from an arbitrary authenticated newer frame.
  return (
    equalBytes(
      encodeCanonical("SessionFrameFields", { ...frame, kind: 0, body: new Uint8Array() }),
      encodeCanonical("SessionFrameFields", { ...expected, kind: 0, body: new Uint8Array() }),
    ) && verifyTag(sessionFrameTag(key, frame), tag)
  );
}

export interface AuthExpectations {
  readonly profile: ProfileIdentity;
  readonly artifactSetDigest: Uint8Array;
  readonly ownerEpoch: Uint8Array;
  readonly endpointInstance: Uint8Array;
  /** Verified OS fact supplied by the future native adapter, not claimed hello PID. */
  readonly verifiedPeer: ProcessIdentity;
  readonly scope?: Scope;
  readonly shutdownInventory?: OwnerShutdownInventory;
  readonly parent?: {
    readonly process: ProcessIdentity;
    readonly session: Uint8Array;
    readonly transcript: Uint8Array;
    readonly statusOnly: boolean;
  };
  readonly generations: Generations;
  readonly credential: Pick<
    ClientHello,
    "kind" | "role" | "lane" | "credentialId" | "replacement" | "laneBinding"
  >;
}
function same(name: CanonicalRecord, a: unknown, b: unknown) {
  return equalBytes(encodeCanonical(name, a), encodeCanonical(name, b));
}
/** Checks immutable bootstrap/owner-held expectations before accepting a proof. No OS attestation. */
export function validateAuthBinding(
  hello: ClientHello,
  fields: ChallengeFields,
  expected: AuthExpectations,
): void {
  encodeCanonical("ClientHello", hello);
  encodeCanonical("ChallengeFields", fields);
  requireContract(equalBytes(expected.verifiedPeer.ownerEpoch, expected.ownerEpoch), "AUTH_FAILED");
  requireContract(
    hello.kind === expected.credential.kind &&
      hello.role === expected.credential.role &&
      hello.lane === expected.credential.lane &&
      equalBytes(hello.credentialId, expected.credential.credentialId) &&
      same("Generations", fields.generations, expected.generations),
    "AUTH_FAILED",
  );
  for (const [key, name] of [
    ["replacement", "ReplacementBinding"],
    ["laneBinding", "LaneBinding"],
  ] as const)
    requireContract(
      !!hello[key] === !!expected.credential[key] &&
        (!hello[key] || same(name, hello[key], expected.credential[key])),
      "AUTH_FAILED",
    );
  requireContract(
    same("ProfileIdentity", fields.profile, expected.profile) &&
      equalBytes(hello.profileDigest, recordDigest("ProfileIdentity", expected.profile)),
    "AUTH_FAILED",
  );
  for (const name of ["artifactSetDigest", "ownerEpoch", "endpointInstance"] as const)
    requireContract(
      equalBytes(hello[name], expected[name]) && equalBytes(fields[name], expected[name]),
      "AUTH_FAILED",
    );
  for (const name of ["credentialId", "clientNonce"] as const)
    requireContract(equalBytes(hello[name], fields[name]), "AUTH_FAILED");
  requireContract(
    hello.role === fields.role && hello.kind === fields.kind && hello.lane === fields.lane,
    "AUTH_FAILED",
  );
  for (const [key, name] of [
    ["rootIntent", "RootIntent"],
    ["replacement", "ReplacementBinding"],
    ["laneBinding", "LaneBinding"],
  ] as const) {
    requireContract(
      !!hello[key] === !!fields[key] && (!hello[key] || same(name, hello[key], fields[key])),
      "AUTH_FAILED",
    );
  }
  requireContract(
    equalBytes(fields.limitsDigest, recordDigest("Limits", fields.limits)),
    "AUTH_FAILED",
  );
  if (hello.kind === 1)
    requireContract(
      !expected.scope && same("ProcessIdentity", hello.rootIntent!.subject, expected.verifiedPeer),
      "AUTH_FAILED",
    );
  else if (hello.role !== 1) {
    requireContract(
      fields.scope &&
        expected.scope &&
        same("Scope", fields.scope, expected.scope) &&
        same("ProcessIdentity", fields.scope.process, expected.verifiedPeer) &&
        equalBytes(fields.scopeDigest, recordDigest("Scope", fields.scope)),
      "AUTH_FAILED",
    );
    if (fields.role === 4) {
      requireContract(expected.shutdownInventory, "AUTH_FAILED");
      new OwnerShutdownInventoryModel(expected.shutdownInventory).authorizeScope(fields.scope);
    }
    requireContract(
      fields.scope.role === fields.role &&
        equalBytes(fields.scope.artifactSetDigest, fields.artifactSetDigest) &&
        same("Generations", fields.generations, fields.scope.generations),
      "AUTH_FAILED",
    );
  }
  if (hello.laneBinding) {
    const binding = hello.laneBinding;
    requireContract(
      expected.parent &&
        !expected.parent.statusOnly &&
        same("ProcessIdentity", expected.parent.process, expected.verifiedPeer) &&
        equalBytes(binding.parentSession, expected.parent.session) &&
        equalBytes(binding.parentTranscript, expected.parent.transcript) &&
        binding.scopeRevision === (fields.scope?.revision ?? "0"),
      "AUTH_FAILED",
    );
    requireContract(
      equalBytes(hello.credentialId, binding.ticketId) &&
        equalBytes(binding.ownerEpoch, fields.ownerEpoch) &&
        equalBytes(binding.endpointInstance, fields.endpointInstance) &&
        binding.role === fields.role &&
        binding.lane === fields.lane &&
        equalBytes(binding.scopeDigest, fields.scopeDigest) &&
        same("Generations", binding.generations, fields.generations),
      "AUTH_FAILED",
    );
  }
}
