import type { V2ThreadRecords } from "./Orchestration.records.ts";
import { decodeV2ThreadReceipt } from "./Orchestration.receipts.schema.ts";
import { v2ReceiptRetirementEvidence } from "./Orchestration.receipts.fence.ts";
import type { V2ReceiptFence } from "./Orchestration.instances.ts";

export interface V2ReceiptMetadata {
  readonly implementationDigest: string;
  readonly requestDigest: string;
  readonly resultEncoding: string;
}

/** Stable invocation keys survive token/epoch rotation; an uncertain reservation never resends. */
export class V2ThreadReceipts {
  private readonly active = new Map<
    string,
    { fingerprint: string; operation: Promise<{ content: string }> }
  >();
  constructor(
    private readonly records: V2ThreadRecords,
    /** This backend instance's dead-backend fence, when it holds the state-directory lock. */
    private readonly fence?: V2ReceiptFence,
  ) {}

  /** Semantic uncertainty is never cleared by physical retirement. */
  async unsettledCount() {
    let count = 0;
    for (const signed of await this.records.entries()) {
      const value = decodeV2ThreadReceipt(signed.value);
      if (value.state === "reserved") count++;
    }
    return count;
  }

  /** Distinct reboot- or dead-backend-fenced physical evidence; receiptsSettled stays false for
   * unknown outcomes. */
  retirementEvidence() {
    return v2ReceiptRetirementEvidence(this.records, this.fence);
  }

  /** Authoritative durable state for settlement evidence. "absent" means no reservation was written,
   * so the canonical request was never issued; "reserved" stays semantic uncertainty and never resends. */
  async durableState(key: string): Promise<"absent" | "reserved" | "completed"> {
    const signed = await this.records.read(key);
    return signed ? decodeV2ThreadReceipt(signed.value).state : "absent";
  }

  async find(key: string, fingerprint: string) {
    const signed = await this.records.read(key);
    if (!signed) return undefined;
    const value = decodeV2ThreadReceipt(signed.value);
    if (
      value.fingerprint !== fingerprint ||
      value.state !== "completed" ||
      Buffer.byteLength(value.result.content) > 120000
    )
      throw new Error("V2 canonical tool outcome uncertain or changed; no automatic re-execution.");
    return value.result;
  }

  /** Identical concurrent calls share settlement, including the single approval before reserve. */
  once(key: string, fingerprint: string, operation: () => Promise<{ content: string }>) {
    const current = this.active.get(key);
    if (current) {
      if (current.fingerprint !== fingerprint)
        return Promise.reject(new Error("V2 canonical tool invocation changed."));
      return current.operation;
    }
    if (this.active.size >= 32)
      return Promise.reject(new Error("V2 canonical tool execution capacity reached."));
    const pending = operation();
    const entry = { fingerprint, operation: pending };
    this.active.set(key, entry);
    void pending
      .finally(() => {
        if (this.active.get(key) === entry) this.active.delete(key);
      })
      .catch(() => {});
    return pending;
  }

  async run(
    key: string,
    fingerprint: string,
    operation: () => Promise<{ content: string }>,
    metadata?: V2ReceiptMetadata,
  ) {
    const replay = await this.find(key, fingerprint);
    if (replay) return replay;
    const identity = {
      fingerprint,
      ...(metadata ? { format: "bigbud.thread.receipt.v2", ...metadata } : {}),
    };
    const revision = await this.records.replace(key, undefined, { ...identity, state: "reserved" });
    const result = await operation();
    if (Buffer.byteLength(result.content) > (metadata ? 90000 : 120000))
      throw new Error("V2 canonical result bound exceeded; receipt retained.");
    await this.records.replace(key, revision, { ...identity, state: "completed", result });
    return result;
  }
}
