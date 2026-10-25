import type { RootIntent, ProcessIdentity } from "@bigbud/contracts/terminal-owner/identity";
import { encodeCanonical, canonicalDomain } from "./canonical";
import { sha256, recordDigest } from "./auth";
import { equalBytes } from "./canonical.validation";
import { requireContract, nextCounter } from "./errors";
import { OrphanLeaseModel } from "./lease.model";

interface Main {
  session: Uint8Array;
  process: ProcessIdentity;
  use: number;
  connected: boolean;
}
interface Candidate {
  session: Uint8Array;
  intent: RootIntent;
  acceptedAt: number;
}
interface Outcome {
  sequence: string;
  attempt: string;
  digest: string;
  generation: string;
  revision: string;
  committed: boolean;
  intentDigest: string;
}
/** Pure root CAS/lost-result model. Authentication alone never installs authority. */
export class OwnerAuthorityModel {
  private main: Main | undefined;
  private candidates = new Map<string, Candidate>();
  private outcomes = new Map<string, Outcome>();
  private handover:
    | { id: Uint8Array; process: ProcessIdentity; use: number; at: number }
    | undefined;
  private revision = "0";
  private generation = "0";
  private highWater = "0";
  private floor = "0";
  private quiescing = false;
  readonly lease = new OrphanLeaseModel();
  private epoch: Uint8Array | undefined;
  authenticated(session: Uint8Array, intent: RootIntent, now: number) {
    encodeCanonical("RootCommit", { intent, candidateSession: session });
    requireContract(Number.isSafeInteger(now) && now >= 0, "CLOCK_INVALID");
    if (intent.mode === 5) return "statusOnly";
    requireContract(
      !this.epoch || equalBytes(this.epoch, intent.subject.ownerEpoch),
      "EPOCH_MISMATCH",
    );
    const id = Buffer.from(session).toString("hex");
    requireContract(
      !this.candidates.has(id) &&
        this.candidates.size < 2 &&
        this.candidates.size + this.outcomes.size < 7,
      "CAPACITY",
    );
    requireContract(
      intent.op.sequence === nextCounter(this.highWater) &&
        !this.outcomes.has(intent.op.sequence) &&
        ![...this.candidates.values()].some((c) => c.intent.op.sequence === intent.op.sequence),
      "CAS_CONFLICT",
    );
    this.highWater = intent.op.sequence;
    this.epoch ??= intent.subject.ownerEpoch.slice();
    this.candidates.set(id, {
      session: session.slice(),
      intent: structuredClone(intent),
      acceptedAt: now,
    });
    return "candidate";
  }
  commit(session: Uint8Array, intent: RootIntent, now: number, oldMainVerifiedExited: boolean) {
    this.lease.sample(now);
    const sequence = intent.op.sequence;
    const attempt = Buffer.from(intent.op.attemptId).toString("hex");
    const kind = new Uint8Array(4);
    new DataView(kind.buffer).setUint32(0, 10);
    const digest = Buffer.from(
      sha256(
        canonicalDomain("root-mutation/v1"),
        intent.subject.ownerEpoch,
        kind,
        encodeCanonical("RootCommit", { intent, candidateSession: session }),
      ),
    ).toString("hex");
    const retained = this.outcomes.get(sequence);
    if (retained) {
      requireContract(
        retained.committed && retained.attempt === attempt && retained.digest === digest,
        "DIGEST_CONFLICT",
      );
      return { ...retained };
    }
    requireContract(BigInt(sequence) > BigInt(this.floor), "EXPIRED_UNKNOWN");
    const id = Buffer.from(session).toString("hex");
    const candidate = this.candidates.get(id);
    requireContract(
      candidate &&
        now >= candidate.acceptedAt &&
        now - candidate.acceptedAt < 5000 &&
        equalBytes(
          encodeCanonical("RootIntent", candidate.intent),
          encodeCanonical("RootIntent", intent),
        ),
      "CANDIDATE_UNAVAILABLE",
    );
    requireContract(
      intent.op.expectedAuthorityRevision === this.revision &&
        intent.expectedMainGeneration === this.generation,
      "CAS_CONFLICT",
    );
    if (this.main)
      requireContract(equalBytes(intent.expectedMainSession, this.main.session), "CAS_CONFLICT");
    else
      requireContract(
        intent.expectedMainSession.every((b) => b === 0),
        "CAS_CONFLICT",
      );
    requireContract(!(this.quiescing || this.lease.expired) || intent.use === 2, "QUIESCING");
    if (intent.mode === 1) requireContract(!this.main || oldMainVerifiedExited, "LIVE_MAIN");
    else if (intent.mode === 2)
      requireContract(
        this.main &&
          !this.main.connected &&
          equalBytes(
            encodeCanonical("ProcessIdentity", this.main.process),
            encodeCanonical("ProcessIdentity", intent.subject),
          ),
        "LIVE_MAIN",
      );
    else if (intent.mode === 3)
      requireContract(
        this.main &&
          this.main.connected &&
          intent.use === this.main.use &&
          equalBytes(
            encodeCanonical("ProcessIdentity", this.main.process),
            encodeCanonical("ProcessIdentity", intent.subject),
          ),
        "LIVE_MAIN",
      );
    else if (intent.mode === 4)
      requireContract(
        this.handover &&
          now < this.handover.at + 5000 &&
          equalBytes(intent.handoverTicket, this.handover.id) &&
          equalBytes(
            encodeCanonical("ProcessIdentity", intent.subject),
            encodeCanonical("ProcessIdentity", this.handover.process),
          ) &&
          intent.use === this.handover.use,
        "HANDOVER_UNAVAILABLE",
      );
    else requireContract(false, "ROLE_DENIED");
    const generation =
      intent.mode === 2 || intent.mode === 3 ? this.generation : nextCounter(this.generation);
    const revision = nextCounter(this.revision);
    const outcome = {
      sequence,
      attempt,
      digest,
      generation,
      revision,
      committed: true,
      intentDigest: Buffer.from(recordDigest("RootIntent", intent)).toString("hex"),
    };
    this.main = {
      session: session.slice(),
      process: structuredClone(intent.subject),
      use: intent.use,
      connected: true,
    };
    this.generation = generation;
    this.revision = revision;
    this.outcomes.set(sequence, outcome);
    this.candidates.delete(id);
    this.handover = undefined;
    if (intent.use === 1) this.lease.commitOrdinaryReattach(now);
    else this.quiescing = true;
    return { ...outcome };
  }
  query(sequence: string, attemptId: Uint8Array, intentDigest: Uint8Array) {
    requireContract(intentDigest.length === 32, "IDENTITY_INVALID");
    encodeCanonical("RootOp", { sequence, attemptId, expectedAuthorityRevision: "0" });
    const outcome = this.outcomes.get(sequence);
    if (
      outcome?.attempt === Buffer.from(attemptId).toString("hex") &&
      outcome.intentDigest === Buffer.from(intentDigest).toString("hex")
    )
      return { state: outcome.committed ? "committed" : "notCommitted", outcome: { ...outcome } };
    if (
      [...this.candidates.values()].some(
        (c) =>
          c.intent.op.sequence === sequence &&
          equalBytes(c.intent.op.attemptId, attemptId) &&
          equalBytes(recordDigest("RootIntent", c.intent), intentDigest),
      )
    )
      return { state: "pending" };
    return { state: BigInt(sequence) <= BigInt(this.floor) ? "expiredUnknown" : "unknown" };
  }
  prepareHandover(
    current: Uint8Array,
    ticket: Uint8Array,
    process: ProcessIdentity,
    use: number,
    now: number,
  ) {
    this.lease.sample(now);
    requireContract(
      this.main?.connected &&
        equalBytes(current, this.main.session) &&
        ticket.length === 32 &&
        ticket.some((b) => b !== 0) &&
        use === this.main.use &&
        !this.quiescing,
      "ROLE_DENIED",
    );
    encodeCanonical("ProcessIdentity", process);
    this.handover = { id: ticket.slice(), process: structuredClone(process), use, at: now };
  }
  disconnect(session: Uint8Array, now: number) {
    this.lease.sample(now);
    const id = Buffer.from(session).toString("hex");
    if (this.candidates.has(id)) this.retire(id);
    if (this.main && equalBytes(session, this.main.session)) {
      this.main.connected = false;
      this.lease.orphan(now);
    }
  }
  beginQuiesce() {
    this.quiescing = true;
  }
  private retire(id: string) {
    const candidate = this.candidates.get(id)!;
    const retained = this.outcomes.get(candidate.intent.op.sequence);
    requireContract(!retained, "OUTCOME_FENCED");
    this.outcomes.set(candidate.intent.op.sequence, {
      sequence: candidate.intent.op.sequence,
      attempt: Buffer.from(candidate.intent.op.attemptId).toString("hex"),
      digest: "",
      generation: this.generation,
      revision: this.revision,
      committed: false,
      intentDigest: Buffer.from(recordDigest("RootIntent", candidate.intent)).toString("hex"),
    });
    this.candidates.delete(id);
  }
  expireCandidates(now: number) {
    this.lease.sample(now);
    for (const [id, c] of this.candidates) if (now >= c.acceptedAt + 5000) this.retire(id);
  }
  status() {
    return {
      generation: this.generation,
      revision: this.revision,
      highWater: this.highWater,
      floor: this.floor,
      quiescing: this.quiescing || this.lease.expired,
      session: this.main?.session.slice(),
      use: this.main?.use,
    };
  }
}
