import { randomUUID } from "node:crypto";
declare const attempt: unique symbol;
/** Fresh local operation identity, allocated before canonical CAS/assets preparation. */
export interface OriginalNativeLeaseAttempt {
  readonly [attempt]: true;
}
export class NativeLeaseAttempts {
  private readonly attempts = new WeakMap<
    OriginalNativeLeaseAttempt,
    { nonce: string; consumed: boolean }
  >();
  private count = 0;
  begin(): OriginalNativeLeaseAttempt {
    if (this.count >= 64) throw Error("Native fresh attempt capacity is exhausted.");
    this.count++;
    const token = Object.freeze({}) as OriginalNativeLeaseAttempt;
    this.attempts.set(token, { nonce: randomUUID(), consumed: false });
    return token;
  }
  nonce(token: OriginalNativeLeaseAttempt): string {
    const value = this.attempts.get(token);
    if (!value) throw Error("Original owner-client fresh attempt token required.");
    return value.nonce;
  }
  consume(token: OriginalNativeLeaseAttempt, nonce: string) {
    const value = this.attempts.get(token);
    if (!value || value.consumed || value.nonce !== nonce)
      throw Error("Original fresh attempt is consumed or does not match this nonce.");
    value.consumed = true;
  }
}
