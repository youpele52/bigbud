const MAX_TARGETS = 1024;
const MAX_FRESH_REQUESTS_PER_WINDOW = 8;
const WINDOW_MS = 60_000;

const tails = new Map<string, Promise<void>>();
const recent = new Map<string, Map<string, number>>();
const lastUsed = new Map<string, number>();

export class RemoteAgentAdmissionRateLimitError extends Error {
  readonly code = "ADMISSION_RATE_LIMITED";
}

/** Serialize fresh activation per target and bound request churn before registry mutation. */
export async function withRemoteAgentAdmissionGuard<A>(
  target: string,
  requestId: string,
  run: () => Promise<A>,
): Promise<A> {
  const now = Date.now();
  pruneInactiveTargets(now);
  let requests = recent.get(target);
  if (!requests) {
    evictInactiveTargets();
    if (recent.size >= MAX_TARGETS)
      throw new RemoteAgentAdmissionRateLimitError("Too many remote targets.");
    requests = new Map();
    recent.set(target, requests);
  }
  lastUsed.set(target, now);
  for (const [id, timestamp] of requests) if (now - timestamp >= WINDOW_MS) requests.delete(id);
  if (requests.size >= MAX_FRESH_REQUESTS_PER_WINDOW && !requests.has(requestId))
    throw new RemoteAgentAdmissionRateLimitError("Remote fresh-admission rate limit exceeded.");
  requests.set(requestId, now);

  const prior = tails.get(target) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prior.then(() => gate);
  tails.set(target, tail);
  await prior;
  try {
    return await run();
  } finally {
    release();
    if (tails.get(target) === tail) tails.delete(target);
    pruneInactiveTargets(Date.now());
  }
}

function pruneInactiveTargets(now: number): void {
  for (const [target, requests] of recent) {
    for (const [id, timestamp] of requests) {
      if (now - timestamp >= WINDOW_MS) requests.delete(id);
    }
    if (requests.size === 0 && !tails.has(target)) {
      recent.delete(target);
      lastUsed.delete(target);
    }
  }
}

function evictInactiveTargets(): void {
  if (recent.size < MAX_TARGETS) return;
  const candidates = [...recent.keys()]
    .filter((target) => !tails.has(target))
    .toSorted((left, right) => (lastUsed.get(left) ?? 0) - (lastUsed.get(right) ?? 0));
  const target = candidates[0];
  if (target !== undefined) {
    recent.delete(target);
    lastUsed.delete(target);
  }
}
