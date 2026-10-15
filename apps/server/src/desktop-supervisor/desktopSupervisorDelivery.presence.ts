/**
 * Whether any interactive client is connected right now (OD6): an open supervised delivery session
 * or a retained external consumer such as the mobile domain-event stream. Per-thread viewing is
 * not tracked; a false positive costs at most one short hold.
 *
 * @module desktopSupervisorDelivery.presence
 */
export class DesktopSupervisorDeliveryPresence {
  private external = 0;

  retainExternal(): () => void {
    this.external += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.external = Math.max(0, this.external - 1);
    };
  }

  hasOpenConsumer(sessions: Iterable<{ readonly closed: boolean }>): boolean {
    if (this.external > 0) return true;
    for (const session of sessions) {
      if (!session.closed) return true;
    }
    return false;
  }

  clear(): void {
    this.external = 0;
  }
}
