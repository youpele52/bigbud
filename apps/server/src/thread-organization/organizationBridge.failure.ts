import { OrganizationResync } from "./organizationLifecycle.ts";

/** One terminal failure per bridge attempt. A routine resync never interrupts serialized
 * acceptance: it waits until the in-flight proposal has sent its receipt (or failed on its
 * own), so Rust never loses an outcome to a resnapshot. Real faults fence immediately.
 */
export class OrganizationFailureGate {
  private proposalInFlight = false;
  private deferred: Error | undefined;
  constructor(private readonly fence: (error: Error) => void) {}

  get inFlight() {
    return this.proposalInFlight;
  }
  fail(error: Error) {
    if (error instanceof OrganizationResync && this.proposalInFlight) {
      this.deferred ??= error;
      return;
    }
    this.fence(error);
  }
  proposalStarted() {
    this.proposalInFlight = true;
  }
  proposalSettled() {
    this.proposalInFlight = false;
    if (this.deferred) this.fence(this.deferred);
  }
}
