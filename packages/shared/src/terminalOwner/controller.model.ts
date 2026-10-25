import { requireContract, nextCounter } from "./errors";

interface AcceptedWork {
  sequence: string;
  digest: string;
  controller: string;
  state: "pending" | "succeeded" | "partialUnknown";
}

/** Metadata-only controller settlement model. No journal, input replay or production PTY interface. */
export class ControllerSettlementModel {
  private generation = "1";
  private active = true;
  private records = new Map<string, AcceptedWork>();
  private highWater = "0";
  private floor = "0";
  private replacements = new Map<string, { expected: string; generation: string }>();
  replace(
    operationId: string,
    expectedGeneration: string,
    rootAuthorized: boolean,
    quiescing: boolean,
  ) {
    requireContract(/^[a-f0-9]{64}$/.test(operationId), "IDENTITY_INVALID");
    requireContract(rootAuthorized, "ROLE_DENIED");
    const retained = this.replacements.get(operationId);
    if (retained) {
      requireContract(retained.expected === expectedGeneration, "DIGEST_CONFLICT");
      return retained.generation;
    }
    requireContract(
      rootAuthorized &&
        !quiescing &&
        this.active &&
        expectedGeneration === this.generation &&
        this.replacements.size < 128,
      "STALE_CONTROLLER",
    );
    this.generation = nextCounter(this.generation);
    this.active = false;
    this.replacements.set(operationId, {
      expected: expectedGeneration,
      generation: this.generation,
    });
    return this.generation;
  }
  activate(
    generation: string,
    rootAuthorized: boolean,
    quiescing: boolean,
    durableSettlementProven: boolean,
  ) {
    requireContract(
      rootAuthorized &&
        !quiescing &&
        generation === this.generation &&
        durableSettlementProven &&
        [...this.records.values()].every((r) => r.state === "succeeded"),
      "SETTLEMENT_PENDING",
    );
    this.active = true;
  }
  admit(id: string, sequence: string, digest: string, controller: string) {
    requireContract(
      /^[a-f0-9]{64}$/.test(id) &&
        /^[a-f0-9]{64}$/.test(digest) &&
        /^(0|[1-9][0-9]{0,19})$/.test(sequence) &&
        BigInt(sequence) <= 18446744073709551615n,
      "IDENTITY_INVALID",
    );
    const retained = this.records.get(id);
    if (retained) {
      requireContract(
        retained.digest === digest && retained.sequence === sequence,
        "DIGEST_CONFLICT",
      );
      return { ...retained };
    }
    requireContract(this.active && controller === this.generation, "STALE_CONTROLLER");
    requireContract(BigInt(sequence) > BigInt(this.floor), "EXPIRED_UNKNOWN");
    requireContract(
      sequence === nextCounter(this.highWater) && this.records.size < 128,
      "CAPACITY",
    );
    const record: AcceptedWork = { sequence, digest, controller, state: "pending" };
    this.records.set(id, record);
    this.highWater = sequence;
    return { ...record };
  }
  settle(id: string, digest: string, state: "succeeded" | "partialUnknown") {
    const record = this.records.get(id);
    requireContract(
      record && record.digest === digest && record.state === "pending",
      "OUTCOME_FENCED",
    );
    record.state = state;
  }
  compactThrough(sequence: string) {
    requireContract(
      /^(0|[1-9][0-9]{0,19})$/.test(sequence) &&
        BigInt(sequence) >= BigInt(this.floor) &&
        BigInt(sequence) <= BigInt(this.highWater),
      "COUNTER_INVALID",
    );
    requireContract(
      [...this.records.values()].every(
        (r) => BigInt(r.sequence) > BigInt(sequence) || r.state === "succeeded",
      ),
      "SETTLEMENT_PENDING",
    );
    for (const [id, r] of this.records)
      if (BigInt(r.sequence) <= BigInt(sequence)) this.records.delete(id);
    this.floor = sequence;
  }
  snapshot() {
    return {
      generation: this.generation,
      active: this.active,
      highWater: this.highWater,
      floor: this.floor,
      records: [...this.records.entries()].map(([id, r]) => ({
        id,
        sequence: r.sequence,
        digest: r.digest,
        controller: r.controller,
        state: r.state,
      })),
    };
  }
}
