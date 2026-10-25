import { requireContract } from "./errors";

/** Samples are receiver-owned awake-monotonic milliseconds, excluding OS suspend. */
export class OrphanLeaseModel {
  private last = 0;
  private start: number | undefined;
  private expiredValue = false;
  sample(awakeNowMs: number) {
    requireContract(Number.isSafeInteger(awakeNowMs) && awakeNowMs >= this.last, "CLOCK_INVALID");
    this.last = awakeNowMs;
    if (this.start !== undefined && awakeNowMs - this.start >= 300000) this.expiredValue = true;
    return this.expiredValue;
  }
  orphan(awakeNowMs: number) {
    this.sample(awakeNowMs);
    if (this.start === undefined) this.start = awakeNowMs;
  }
  remaining(awakeNowMs: number) {
    this.sample(awakeNowMs);
    return this.start === undefined || this.expiredValue ? 0 : 300000 - (awakeNowMs - this.start);
  }
  commitOrdinaryReattach(awakeNowMs: number) {
    requireContract(!this.sample(awakeNowMs), "LEASE_EXPIRED");
    this.start = undefined;
  }
  get expired() {
    return this.expiredValue;
  }
}
