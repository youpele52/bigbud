/**
 * In-process ledger of canonical thread-tool executions, keyed by invocation id.
 *
 * A caller in this server process (the OpenCode V2 bridge) registers a dispatch before it sends a
 * request to this server's own `/api/internal/thread-tools` route; the route enters the invocation
 * before any effectful handler runs and leaves it when the handler fiber has ended (completion,
 * failure or interruption). JavaScript runs both sides on one thread, so each transition is atomic:
 *
 * - A dispatch that settles before the route entered it is fenced; the route then refuses that
 *   invocation if it arrives later, so an abandoned request can never start an effect.
 * - While a dispatch or a route handler for the id is open, the invocation is in flight and a
 *   "reserved" durable receipt is not proof that no effect remains.
 *
 * No timer participates. Fences are bounded by count (oldest evicted first).
 *
 * @module threadToolInvocationFlights
 */

const MAX_FENCES = 1024;

const dispatching = new Map<string, { started: boolean }>();
const running = new Map<string, number>();
const fenced = new Set<string>();

function fence(invocationId: string) {
  fenced.add(invocationId);
  while (fenced.size > MAX_FENCES) {
    const oldest = fenced.values().next().value;
    if (oldest === undefined) break;
    fenced.delete(oldest);
  }
}

/** Caller side: open a dispatch before the request is sent; call the result once it settled. */
export function beginThreadToolDispatch(invocationId: string): () => void {
  const flight = { started: false };
  fenced.delete(invocationId);
  dispatching.set(invocationId, flight);
  let settled = false;
  return () => {
    if (settled) return;
    settled = true;
    if (dispatching.get(invocationId) === flight) dispatching.delete(invocationId);
    if (!flight.started && !running.has(invocationId)) fence(invocationId);
  };
}

/** Route side: `undefined` refuses an invocation its caller already abandoned; otherwise call the
 * result exactly when the handler has ended. */
export function enterThreadToolInvocation(invocationId: string): (() => void) | undefined {
  if (fenced.delete(invocationId)) return undefined;
  const flight = dispatching.get(invocationId);
  if (flight) flight.started = true;
  running.set(invocationId, (running.get(invocationId) ?? 0) + 1);
  let left = false;
  return () => {
    if (left) return;
    left = true;
    const remaining = (running.get(invocationId) ?? 1) - 1;
    if (remaining > 0) running.set(invocationId, remaining);
    else running.delete(invocationId);
  };
}

/** True while a dispatch or a route handler for this invocation may still produce an effect. */
export function isThreadToolInvocationInFlight(invocationId: string): boolean {
  return dispatching.has(invocationId) || running.has(invocationId);
}
