import type { CleanupGrantResult } from "@bigbud/contracts/terminal-owner/auth";
import type { Scope, LaneBinding } from "@bigbud/contracts/terminal-owner/identity";
import type { OwnerShutdownInventory } from "@bigbud/contracts/terminal-owner/shutdown";
import { encodeCanonical, canonicalDomain } from "./canonical";
import { recordDigest, sha256 } from "./auth";
import { equalBytes } from "./canonical.validation";
import { requireContract } from "./errors";
import { OwnerShutdownInventoryModel } from "./shutdownInventory.model";
import { cleanupU32 } from "./cleanup.model.records";

interface Grant {
  result: CleanupGrantResult;
  encoded: Uint8Array;
  expiresAt: number;
  issuedAt: number;
  consumed: boolean;
  revoked: boolean;
  attempt: number;
}
const key = (id: Uint8Array) => Buffer.from(id).toString("hex");

/** Two prepaid immutable cleanup grant capsules, tied to the owner's actual admission inventory. */
export class CleanupGrantModel {
  private readonly owner: OwnerShutdownInventoryModel;
  private grants = new Map<string, Grant>();
  private sessions = new Map<
    string,
    { session: Uint8Array; transcript: Uint8Array; endpoint: Uint8Array }
  >();
  private tickets = new Map<
    string,
    { grant: string; binding: LaneBinding; consumed: boolean; issuedAt: number }
  >();
  constructor(ownerHeld: OwnerShutdownInventory) {
    this.owner = new OwnerShutdownInventoryModel(ownerHeld);
  }
  issue(result: CleanupGrantResult, attempt: number, now: number, deadline: number) {
    this.owner.authorizeScope(result.scope);
    const binding = this.owner.snapshot().binding;
    const child = result.outcome.child;
    requireContract(
      [1, 2].includes(attempt) &&
        result.scope.generations.controller === String(attempt) &&
        result.scope.revision === "1" &&
        child.class === 3 &&
        child.slot === (attempt === 1 ? 10 : 13) &&
        child.parentRootSequence === binding.parentRootSequence &&
        equalBytes(child.shutdownId, binding.shutdownId) &&
        equalBytes(child.resourceIdentity, binding.inventoryCut),
      "INVENTORY_DENIED",
    );
    const childId = sha256(
      canonicalDomain("cleanup-child/v1"),
      binding.ownerEpoch,
      binding.shutdownId,
      Uint8Array.of(3),
      cleanupU32(child.slot),
      binding.inventoryCut,
    );
    requireContract(
      equalBytes(childId, result.outcome.childId) &&
        equalBytes(recordDigest("Scope", result.scope), result.scopeDigest),
      "INVENTORY_DENIED",
    );
    const encoded = encodeCanonical("CleanupGrantResult", result);
    requireContract(
      encoded.length <= 8192 &&
        Number.isSafeInteger(now) &&
        now >= 0 &&
        Number.isSafeInteger(deadline) &&
        deadline > now &&
        deadline <= now + 30000,
      "GRANT_UNAVAILABLE",
    );
    const existing = this.grants.get(key(result.grantId));
    if (existing) {
      requireContract(
        equalBytes(encoded, existing.encoded) && existing.attempt === attempt,
        "DIGEST_CONFLICT",
      );
      return;
    }
    requireContract(
      this.grants.size < 2 && ![...this.grants.values()].some((g) => g.attempt === attempt),
      "CAPACITY",
    );
    this.grants.set(key(result.grantId), {
      result: structuredClone(result),
      encoded,
      issuedAt: now,
      expiresAt: deadline,
      consumed: false,
      revoked: false,
      attempt,
    });
  }
  consume(id: Uint8Array, scope: Scope, now: number) {
    const grant = this.grants.get(key(id));
    requireContract(
      grant &&
        !grant.consumed &&
        !grant.revoked &&
        Number.isSafeInteger(now) &&
        now >= grant.issuedAt &&
        now < grant.expiresAt,
      "GRANT_UNAVAILABLE",
    );
    requireContract(
      equalBytes(encodeCanonical("Scope", scope), encodeCanonical("Scope", grant.result.scope)),
      "SCOPE_REVOKED",
    );
    this.owner.authorizeScope(scope);
    grant.consumed = true;
  }
  assertActive(id: Uint8Array, scope: Scope, now: number) {
    const grant = this.grants.get(key(id));
    requireContract(
      grant?.consumed &&
        !grant.revoked &&
        Number.isSafeInteger(now) &&
        now >= grant.issuedAt &&
        now < grant.expiresAt &&
        equalBytes(encodeCanonical("Scope", scope), encodeCanonical("Scope", grant.result.scope)),
      "SCOPE_REVOKED",
    );
    this.owner.authorizeScope(scope);
  }
  authorizePty(id: Uint8Array, scope: Scope, ptyId: Uint8Array, generation: string, now: number) {
    this.assertActive(id, scope, now);
    this.owner.authorizePty(scope, ptyId, generation);
  }
  revoke(id: Uint8Array) {
    const grant = this.grants.get(key(id));
    requireContract(grant, "GRANT_UNAVAILABLE");
    grant.revoked = true;
    grant.result.secret.fill(0);
  }
  revokeAttempt(attempt: number) {
    for (const grant of this.grants.values())
      if (grant.attempt === attempt) this.revoke(grant.result.grantId);
  }
  installSession(
    id: Uint8Array,
    scope: Scope,
    session: Uint8Array,
    transcript: Uint8Array,
    endpoint: Uint8Array,
    now: number,
  ) {
    this.assertActive(id, scope, now);
    requireContract(
      session.length === 32 &&
        session.some((b) => b !== 0) &&
        transcript.length === 32 &&
        endpoint.length === 32 &&
        endpoint.some((b) => b !== 0) &&
        !this.sessions.has(key(id)),
      "SCOPE_REVOKED",
    );
    this.sessions.set(key(id), {
      session: session.slice(),
      transcript: transcript.slice(),
      endpoint: endpoint.slice(),
    });
  }
  private checkTicket(id: Uint8Array, scope: Scope, binding: LaneBinding, now: number) {
    this.assertActive(id, scope, now);
    encodeCanonical("LaneBinding", binding);
    const parent = this.sessions.get(key(id));
    requireContract(
      parent &&
        BigInt(binding.serial) > 0n &&
        equalBytes(binding.endpointInstance, parent.endpoint) &&
        binding.role === 4 &&
        binding.lane === 2 &&
        binding.scopeRevision === scope.revision &&
        equalBytes(binding.parentSession, parent.session) &&
        equalBytes(binding.parentTranscript, parent.transcript) &&
        equalBytes(binding.ownerEpoch, this.owner.snapshot().binding.ownerEpoch) &&
        equalBytes(binding.scopeDigest, recordDigest("Scope", scope)) &&
        equalBytes(
          encodeCanonical("Generations", binding.generations),
          encodeCanonical("Generations", scope.generations),
        ),
      "SCOPE_REVOKED",
    );
  }
  issueStatusTicket(id: Uint8Array, scope: Scope, binding: LaneBinding, now: number) {
    this.checkTicket(id, scope, binding, now);
    requireContract(this.tickets.size < 2 && !this.tickets.has(key(binding.ticketId)), "CAPACITY");
    requireContract(
      ![...this.tickets.values()].some(
        (t) => t.grant === key(id) && t.binding.serial === binding.serial,
      ),
      "IDENTITY_CONFLICT",
    );
    this.tickets.set(key(binding.ticketId), {
      grant: key(id),
      binding: structuredClone(binding),
      consumed: false,
      issuedAt: now,
    });
  }
  consumeStatusTicket(id: Uint8Array, scope: Scope, binding: LaneBinding, now: number) {
    this.checkTicket(id, scope, binding, now);
    const ticket = this.tickets.get(key(binding.ticketId));
    requireContract(
      ticket &&
        !ticket.consumed &&
        now >= ticket.issuedAt &&
        now < ticket.issuedAt + 5000 &&
        ticket.grant === key(id) &&
        equalBytes(
          encodeCanonical("LaneBinding", ticket.binding),
          encodeCanonical("LaneBinding", binding),
        ),
      "GRANT_UNAVAILABLE",
    );
    ticket.consumed = true;
  }
  inventorySnapshot() {
    return this.owner.snapshot();
  }
  snapshot() {
    return {
      grants: this.grants.size,
      capsuleBytes: [...this.grants.values()].reduce(
        (bytes, grant) => bytes + grant.encoded.length,
        0,
      ),
    };
  }
}
