import { canonicalDomain } from "./canonical";
import { sha256 } from "./auth";
import { equalBytes } from "./canonical.validation";
import { requireContract, nextCounter } from "./errors";
import { cleanupU32 } from "./cleanup.model.records";

/** Final settlement cut is separate from the immutable admission inventory used by grants. */
export class CleanupSettlementModel {
  private revision = "0";
  private frozen: { cut: Uint8Array; revision: string; writer: number } | undefined;
  private receipt: Uint8Array | undefined;
  changed() {
    this.revision = nextCounter(this.revision);
    this.frozen = undefined;
    this.receipt = undefined;
  }
  childChanged(kind: number, slot: number) {
    if (
      this.hasReceipt &&
      ((kind === 3 && [4, 6, 7, 15].includes(slot)) || this.isWriterTransition(kind, slot))
    )
      return;
    this.changed();
  }
  resourceChanged(kind: number, slot: number, clean: boolean) {
    // Only the recorded still-running settlement writer's *verified exit* follows its receipt.
    if (this.hasReceipt && clean && kind === 2 && slot === 29 + this.frozen!.writer) return;
    this.changed();
  }
  private isWriterTransition(kind: number, slot: number) {
    const writer = this.frozen!.writer;
    return (
      (kind === 2 && slot === 29 + writer) || (kind === 3 && slot === (writer === 1 ? 11 : 14))
    );
  }
  freeze(parentCut: Uint8Array, writer: number) {
    if (this.frozen) {
      requireContract(this.frozen.writer === writer, "RECEIPT_INVALID");
      return this.frozen.cut.slice();
    }
    const revision = new Uint8Array(8);
    new DataView(revision.buffer).setBigUint64(0, BigInt(this.revision));
    const cut = sha256(
      canonicalDomain("final-settlement-model/v2"),
      parentCut,
      revision,
      cleanupU32(writer),
    );
    this.frozen = { cut, revision: this.revision, writer };
    return cut.slice();
  }
  report(cut: Uint8Array, receipt: Uint8Array, writer: number, commitRecord: () => void) {
    requireContract(
      this.frozen &&
        this.frozen.revision === this.revision &&
        this.frozen.writer === writer &&
        equalBytes(cut, this.frozen.cut) &&
        receipt.length === 32,
      "RECEIPT_INVALID",
    );
    requireContract(!this.receipt || equalBytes(receipt, this.receipt), "DIGEST_CONFLICT");
    const retained = receipt.slice();
    commitRecord();
    // No rejecting validation or allocation remains after the record commit.
    this.receipt = retained;
  }
  get hasReceipt() {
    return !!this.receipt && this.frozen?.revision === this.revision;
  }
  get isFrozen() {
    return this.frozen !== undefined;
  }
  snapshot() {
    return {
      outcomeCut: this.revision,
      cut: this.frozen?.cut.slice(),
      receipt: this.receipt?.slice(),
      writer: this.frozen?.writer,
    };
  }
}
