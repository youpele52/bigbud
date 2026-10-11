import { sha256 } from "./auth";
import type { CleanupChildRecordsModel } from "./cleanup.model.records";
import type { CleanupSettlementModel } from "./cleanup.model.settlement";

/** A changed cut cannot reuse the immutable receipt child; rejection must not revive a receipt. */
export function commitCleanupReceipt(
  settlement: CleanupSettlementModel,
  children: CleanupChildRecordsModel,
  cut: Uint8Array,
  receipt: Uint8Array,
  writer: number,
) {
  const payload = sha256(cut, receipt);
  settlement.report(cut, receipt, writer, () => {
    // accept checks every admission/conflict condition before mutation; clean disposition
    // cannot reject that admitted record. Receipt metadata does not advance the outcome cut.
    children.accept(3, 4, 0, payload, true);
    children.disposition(3, 4, true);
  });
}
