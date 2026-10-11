import type {
  CleanupGrantResult,
  ChallengeFields,
  ClientHello,
} from "@bigbud/contracts/terminal-owner/auth";
import type { OwnerShutdownInventory } from "@bigbud/contracts/terminal-owner/shutdown";
import {
  recordDigest,
  type AuthExpectations,
  sha256,
  transcriptDigest,
  transcriptProof,
  finishAck,
} from "./auth";
import { OwnerAuthExchange } from "./auth.model";
import { CleanupGrantModel } from "./cleanupGrant.model";
import { canonicalDomain } from "./canonical";
import { cleanupU32 } from "./cleanup.model.records";
import { vectors, id } from "./test.fixture";

/** Typed synthetic grant derived from the actual owner capture; expectations come from that owner. */
export function cleanupGrantFixture(
  inventory: OwnerShutdownInventory,
  attempt = 1,
): CleanupGrantResult {
  const result = structuredClone(vectors.records.CleanupGrantResult) as CleanupGrantResult;
  const scope: CleanupGrantResult["scope"] = {
    ...result.scope,
    generations: { ...result.scope.generations, controller: String(attempt) },
    process: { ...result.scope.process, ownerEpoch: inventory.binding.ownerEpoch },
    shutdownId: inventory.binding.shutdownId,
    cleanupInventory: inventory.binding,
  };
  const slot = attempt === 1 ? 10 : 13;
  const outcome: CleanupGrantResult["outcome"] = {
    ...result.outcome,
    child: {
      parentRootSequence: inventory.binding.parentRootSequence,
      shutdownId: inventory.binding.shutdownId,
      class: 3,
      slot,
      resourceIdentity: inventory.binding.inventoryCut,
    },
    childId: sha256(
      canonicalDomain("cleanup-child/v1"),
      inventory.binding.ownerEpoch,
      inventory.binding.shutdownId,
      Uint8Array.of(3),
      cleanupU32(slot),
      inventory.binding.inventoryCut,
    ),
  };
  return {
    ...result,
    grantId: id(39 + attempt),
    secret: id(45 + attempt),
    scope,
    scopeDigest: recordDigest("Scope", scope),
    outcome,
  };
}
export function cleanupAuthFixture(grant: CleanupGrantResult, inventory: OwnerShutdownInventory) {
  const hello: ClientHello = {
    ...(structuredClone(vectors.records.CleanupClientHello) as ClientHello),
    credentialId: grant.grantId,
    ownerEpoch: inventory.binding.ownerEpoch,
  };
  const fields: ChallengeFields = {
    ...(structuredClone(vectors.records.CleanupChallengeFields) as ChallengeFields),
    credentialId: grant.grantId,
    ownerEpoch: inventory.binding.ownerEpoch,
    scope: grant.scope,
    scopeDigest: grant.scopeDigest,
    generations: grant.scope.generations,
  };
  const expected: AuthExpectations = {
    profile: fields.profile,
    artifactSetDigest: fields.artifactSetDigest,
    ownerEpoch: fields.ownerEpoch,
    endpointInstance: fields.endpointInstance,
    verifiedPeer: grant.scope.process,
    scope: grant.scope,
    shutdownInventory: inventory,
    generations: fields.generations,
    credential: hello,
  };
  return { hello, fields, expected, key: grant.secret };
}

/** Compose the model boundary without borrowing any ordinary grant/response permit. */
export function authenticateCleanupGrant(
  grants: CleanupGrantModel,
  grant: CleanupGrantResult,
  inventory: OwnerShutdownInventory,
  now: number,
  check: () => void = () => {},
) {
  const { hello, fields, expected, key } = cleanupAuthFixture(grant, inventory);
  const exchange = new OwnerAuthExchange(hello, fields, key, expected, now);
  check();
  const transcript = transcriptDigest(hello, fields);
  const finish = exchange.prove(
    {
      handshakeId: fields.handshakeId,
      transcript,
      clientProof: transcriptProof(key, "client-proof", transcript),
    },
    now,
    () => grants.consume(grant.grantId, grant.scope, now),
    () => {},
  );
  check();
  exchange.acknowledge(finishAck(key, finish), now, () =>
    grants.assertActive(grant.grantId, grant.scope, now),
  );
  check();
  for (const pty of inventory.ptys)
    grants.authorizePty(grant.grantId, grant.scope, pty.ptyId, pty.terminalGeneration, now);
  return exchange;
}
