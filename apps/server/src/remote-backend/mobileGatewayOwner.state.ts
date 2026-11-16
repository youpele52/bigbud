export type MobileGatewayOwnerPhase = "idle" | "starting" | "running" | "revoking" | "repair";
type End = "disabled" | "revoked";

/** In-memory lifetime only. It never grants process, route, consent or installation authority. */
export class MobileGatewayOwnerState {
  private phase: MobileGatewayOwnerPhase = "idle";
  private current: ReturnType<MobileGatewayOwnerState["createLease"]> | null = null;
  private readonly listeners = new Set<() => void>();

  getPhase = () => this.phase;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(phase: MobileGatewayOwnerPhase) {
    this.phase = phase;
    for (const listener of this.listeners) listener();
  }
  private createLease() {
    const controller = new AbortController();
    return { controller, reason: "disabled" as End, admitted: false };
  }
  begin() {
    if (this.current || this.phase === "repair")
      throw new Error("Gateway owner requires settled prior lifetime or explicit repair.");
    const lease = this.createLease();
    this.current = lease;
    this.publish("starting");
    return Object.freeze({
      signal: lease.controller.signal,
      isCurrent: () => this.current === lease && !lease.controller.signal.aborted,
      isAdmitted: () =>
        this.current === lease && lease.admitted && !lease.controller.signal.aborted,
      admit: () => {
        if (this.current !== lease || lease.controller.signal.aborted)
          throw new Error("Gateway lifetime ended before admission.");
        lease.admitted = true;
        this.publish("running");
      },
      endReason: () => lease.reason,
      invalidate: (reason: End) => {
        if (this.current !== lease) return;
        if (reason === "revoked") lease.reason = reason;
        lease.admitted = false;
        // Status loses admission before synchronous subscribers or abort listeners execute.
        this.publish("revoking");
        lease.controller.abort();
      },
      settle: (repaired: boolean) => {
        if (this.current !== lease) return;
        lease.admitted = false;
        lease.controller.abort();
        this.current = null;
        this.publish(repaired ? "idle" : "repair");
      },
    });
  }
}
