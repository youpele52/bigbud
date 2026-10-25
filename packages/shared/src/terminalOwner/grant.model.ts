import type { Scope } from "@bigbud/contracts/terminal-owner/identity";
import { encodeCanonical } from "./canonical";
import { equalBytes } from "./canonical.validation";
import { requireContract } from "./errors";
import { ReservationPoolModel } from "./reservation.model";

interface Grant {
  scope: Scope;
  key: Uint8Array;
  issuedAt: number;
  consumed: boolean;
  revoked: boolean;
}
interface Replacement {
  oldId: string;
  oldSession: string;
  newId: string;
  candidate?: string;
}
const identity = (id: Uint8Array) => {
  requireContract(id.length === 32 && id.some((b) => b !== 0), "IDENTITY_INVALID");
  return Buffer.from(id).toString("hex");
};

/** Ordinary grant/whole-scope replacement model; cleanup grants belong to the prepaid parent arena. */
export class ScopedGrantModel {
  private grants = new Map<string, Grant>();
  private readonly pool = new ReservationPoolModel(65536, 126, 8192);
  private active = new Map<number, { grant: string; session: string }>();
  private pending = new Map<number, Replacement>();
  issue(
    id: Uint8Array,
    key: Uint8Array,
    scope: Scope,
    now: number,
    currentMain: boolean,
    quiescing: boolean,
  ) {
    requireContract(
      currentMain &&
        !quiescing &&
        scope.role !== 4 &&
        key.length === 32 &&
        Number.isSafeInteger(now) &&
        now >= 0,
      "ROLE_DENIED",
    );
    const name = identity(id);
    requireContract(!this.grants.has(name), "IDENTITY_CONFLICT");
    const bytes = encodeCanonical("Scope", scope).length + 96;
    this.pool.reserve(bytes);
    this.grants.set(name, {
      scope: structuredClone(scope),
      key: key.slice(),
      issuedAt: now,
      consumed: false,
      revoked: false,
    });
  }
  consume(id: Uint8Array, scope: Scope, now: number) {
    const grant = this.grants.get(identity(id));
    requireContract(
      grant &&
        !grant.consumed &&
        !grant.revoked &&
        Number.isSafeInteger(now) &&
        now >= grant.issuedAt &&
        now - grant.issuedAt < 30000,
      "GRANT_UNAVAILABLE",
    );
    requireContract(
      equalBytes(encodeCanonical("Scope", scope), encodeCanonical("Scope", grant.scope)),
      "SCOPE_REVOKED",
    );
    grant.consumed = true;
    grant.key.fill(0);
  }
  installInitial(id: Uint8Array, session: Uint8Array, currentMain: boolean, quiescing: boolean) {
    const name = identity(id);
    const grant = this.grants.get(name);
    requireContract(
      currentMain &&
        !quiescing &&
        grant?.consumed &&
        !grant.revoked &&
        !this.active.has(grant.scope.role),
      "ROLE_DENIED",
    );
    this.active.set(grant.scope.role, { grant: name, session: identity(session) });
  }
  prepareReplacement(
    role: number,
    oldSession: Uint8Array,
    newId: Uint8Array,
    currentMain: boolean,
    quiescing: boolean,
  ) {
    const active = this.active.get(role);
    const freshId = identity(newId);
    const fresh = this.grants.get(freshId);
    requireContract(
      currentMain &&
        !quiescing &&
        active &&
        active.session === identity(oldSession) &&
        !this.pending.has(role) &&
        fresh &&
        !fresh.consumed &&
        !fresh.revoked,
      "REPLACEMENT_DENIED",
    );
    const old = this.grants.get(active.grant)!;
    requireContract(
      fresh.scope.role === role &&
        BigInt(fresh.scope.revision) === BigInt(old.scope.revision) + 1n &&
        equalBytes(
          encodeCanonical("ProcessIdentity", fresh.scope.process),
          encodeCanonical("ProcessIdentity", old.scope.process),
        ) &&
        equalBytes(fresh.scope.artifactSetDigest, old.scope.artifactSetDigest) &&
        equalBytes(
          encodeCanonical("Generations", fresh.scope.generations),
          encodeCanonical("Generations", old.scope.generations),
        ) &&
        fresh.scope.use === old.scope.use,
      "REPLACEMENT_DENIED",
    );
    this.pending.set(role, { oldId: active.grant, oldSession: active.session, newId: freshId });
  }
  markDormant(role: number, newId: Uint8Array, candidate: Uint8Array, now: number) {
    const pending = this.pending.get(role);
    const grant = this.grants.get(identity(newId));
    requireContract(
      pending?.newId === identity(newId) &&
        !pending.candidate &&
        grant?.consumed &&
        !grant.revoked &&
        now >= grant.issuedAt &&
        now < grant.issuedAt + 30000,
      "REPLACEMENT_DENIED",
    );
    pending.candidate = identity(candidate);
  }
  commitReplacement(
    role: number,
    candidate: Uint8Array,
    currentMain: boolean,
    quiescing: boolean,
    now: number,
  ) {
    const pending = this.pending.get(role);
    const active = this.active.get(role);
    requireContract(
      currentMain &&
        !quiescing &&
        pending &&
        active?.grant === pending.oldId &&
        active.session === pending.oldSession &&
        pending.candidate === identity(candidate),
      "REPLACEMENT_DENIED",
    );
    const fresh = this.grants.get(pending.newId)!;
    requireContract(
      !fresh.revoked &&
        fresh.consumed &&
        Number.isSafeInteger(now) &&
        now >= fresh.issuedAt &&
        now < fresh.issuedAt + 30000,
      "REPLACEMENT_DENIED",
    );
    this.grants.get(pending.oldId)!.revoked = true;
    this.active.set(role, { grant: pending.newId, session: pending.candidate });
    this.pending.delete(role);
  }
  cancelReplacement(role: number) {
    const pending = this.pending.get(role);
    if (pending) {
      this.grants.get(pending.newId)!.revoked = true;
      this.grants.get(pending.newId)!.key.fill(0);
      this.pending.delete(role);
    }
  }
  isActive(role: number, id: Uint8Array, session: Uint8Array) {
    const active = this.active.get(role);
    return active?.grant === identity(id) && active.session === identity(session);
  }
  snapshot() {
    return {
      grants: this.grants.size,
      bytes: this.pool.snapshot().bytes,
      pending: this.pending.size,
    };
  }
}
