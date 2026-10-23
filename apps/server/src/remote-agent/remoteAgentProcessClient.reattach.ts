import { RemoteAgentConnectionError } from "./remoteAgentConnection.ts";
import {
  RemoteAgentCapabilityError,
  isRemoteAgentRestartError,
} from "./remoteAgentConnectionPool.errors.ts";
import { waitForRemoteAgentReattachWake } from "./remoteAgentProcessClient.wake.ts";

export const REMOTE_AGENT_IMMEDIATE_REATTACH_ATTEMPTS = 3;
export const REMOTE_AGENT_REATTACH_MIN_BACKOFF_MS = 1_000;
export const REMOTE_AGENT_REATTACH_MAX_BACKOFF_MS = 30_000;
/**
 * How long the agent keeps a terminal result after the process ends. Mirrors
 * `PROCESS_RESULT_RETENTION` in `crates/bigbud-remote-agent/src/session/core.rs`.
 * Running operations never expire, so a result is retrievable for at least
 * this long after the link dropped.
 */
export const REMOTE_AGENT_RESULT_RETENTION_MS = 24 * 60 * 60 * 1_000;

export interface RemoteAgentReattachEnvironment {
  readonly now: () => number;
  /** Resolves after `ms`, or early when `signal` aborts. */
  readonly delay: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Resolves on the next network-online or sleep epoch-ended signal. */
  readonly waitForWake: (signal: AbortSignal) => Promise<void>;
  readonly random: () => number;
  readonly retentionMs: number;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export const defaultRemoteAgentReattachEnvironment: RemoteAgentReattachEnvironment = {
  now: Date.now,
  delay: abortableDelay,
  waitForWake: waitForRemoteAgentReattachWake,
  random: Math.random,
  retentionMs: REMOTE_AGENT_RESULT_RETENTION_MS,
};

let configuredEnvironment = defaultRemoteAgentReattachEnvironment;

/** The environment process clients use unless one is injected. */
export function currentRemoteAgentReattachEnvironment(): RemoteAgentReattachEnvironment {
  return configuredEnvironment;
}

/**
 * Overrides parts of the shared reattach environment, for example a short
 * retention in tests that model a permanently lost link. Returns a restore.
 */
export function configureRemoteAgentReattachEnvironment(
  overrides: Partial<RemoteAgentReattachEnvironment>,
): () => void {
  const previous = configuredEnvironment;
  configuredEnvironment = { ...previous, ...overrides };
  return () => {
    configuredEnvironment = previous;
  };
}

/** Exponential backoff from 1 s to 30 s with equal jitter; `random` is in [0, 1). */
export function remoteAgentReattachBackoffMs(delayedAttempt: number, random: number): number {
  const exponent = Math.min(Math.max(delayedAttempt, 0), 16);
  const base = Math.min(
    REMOTE_AGENT_REATTACH_MAX_BACKOFF_MS,
    REMOTE_AGENT_REATTACH_MIN_BACKOFF_MS * 2 ** exponent,
  );
  const jittered = base / 2 + (Math.min(Math.max(random, 0), 1) * base) / 2;
  return Math.round(
    Math.min(
      REMOTE_AGENT_REATTACH_MAX_BACKOFF_MS,
      Math.max(REMOTE_AGENT_REATTACH_MIN_BACKOFF_MS, jittered),
    ),
  );
}

const DEFINITIVE_CONNECTION_CODES = new Set([
  "IDENTITY_MISMATCH",
  "UNSUPPORTED_PROTOCOL_MAJOR",
  "INVALID_LIMITS",
]);

/**
 * Failures that waiting cannot fix: the agent restarted (its operations are
 * expired, never re-run), or the reachable agent is a different runtime.
 * Everything else, such as a closed socket or an unreachable host, is a
 * transport interruption and is retried.
 */
export function isDefinitiveReattachFailure(cause: unknown): boolean {
  if (isRemoteAgentRestartError(cause)) return true;
  if (cause instanceof RemoteAgentCapabilityError) return true;
  return (
    cause instanceof RemoteAgentConnectionError &&
    cause.code !== undefined &&
    DEFINITIVE_CONNECTION_CODES.has(cause.code)
  );
}

/**
 * One reattach effort for one operation, shared across nested reconnects.
 * Reattach never spawns: every attempt is a `processAttachRequest`. Once the
 * agent answers an attach, `reset` makes the next drop start over: three
 * immediate attempts again, and a deadline counted from that last contact.
 */
export class RemoteAgentReattachRecovery {
  private attemptCount = 0;
  private delayedAttempts = 0;
  /** Every attempt of the operation, never reset, so attach request IDs stay unique. */
  private totalAttempts = 0;
  private deadline: number;

  constructor(private readonly environment: RemoteAgentReattachEnvironment) {
    this.deadline = environment.now() + environment.retentionMs;
  }

  get attempts(): number {
    return this.totalAttempts;
  }

  /** The agent answered an attach: the link is back. */
  reset(): void {
    this.attemptCount = 0;
    this.delayedAttempts = 0;
    this.deadline = this.environment.now() + this.environment.retentionMs;
  }

  /**
   * Resolves when the next attempt may start: at once for the first three,
   * then on a wake signal or after the jittered backoff, whichever is first.
   * Returns "expired" once the retained result would have expired.
   */
  async beforeAttempt(): Promise<"attempt" | "expired"> {
    if (this.attemptCount < REMOTE_AGENT_IMMEDIATE_REATTACH_ATTEMPTS) {
      this.attemptCount += 1;
      this.totalAttempts += 1;
      return "attempt";
    }
    const remaining = this.deadline - this.environment.now();
    if (remaining <= 0) return "expired";
    const backoff = remoteAgentReattachBackoffMs(this.delayedAttempts, this.environment.random());
    const controller = new AbortController();
    const woke = await Promise.race([
      this.environment.waitForWake(controller.signal).then(() => true),
      this.environment.delay(Math.min(backoff, remaining), controller.signal).then(() => false),
    ]);
    controller.abort();
    // A wake means the network is likely back: retry promptly from then on.
    this.delayedAttempts = woke ? 0 : this.delayedAttempts + 1;
    if (this.environment.now() >= this.deadline) return "expired";
    this.attemptCount += 1;
    this.totalAttempts += 1;
    return "attempt";
  }
}
