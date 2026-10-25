/**
 * Whether any interactive client is connected right now (OD6): an open supervised delivery session
 * (desktop or web). The mobile domain-event stream bypasses supervised delivery and deliberately
 * does not count, because the mobile client has no model-choice picker (M5). Per-thread viewing is
 * not tracked; a false positive costs at most one short hold.
 *
 * @module desktopSupervisorDelivery.presence
 */
export function hasOpenDeliveryConsumer(sessions: Iterable<{ readonly closed: boolean }>): boolean {
  for (const session of sessions) {
    if (!session.closed) return true;
  }
  return false;
}
