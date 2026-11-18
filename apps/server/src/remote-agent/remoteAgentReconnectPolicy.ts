import { isDefinitiveReattachFailure } from "./remoteAgentProcessClient.reattach.ts";

/**
 * Phases 1–6 contract: transient reconnects use jittered 1/2/4/8/16/30-second delays with at
 * most ten attempts per episode, and stop immediately for authentication or host-key failures.
 * A manual retry or network recovery starts a new episode.
 */
export const REMOTE_AGENT_RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
export const REMOTE_AGENT_RECONNECT_ATTEMPTS_PER_EPISODE = 10;

const CREDENTIAL_OR_HOST_TRUST =
  /host key verification failed|identity has changed|REMOTE HOST IDENTIFICATION HAS CHANGED|revoked host key|permission denied|authentication|password is required|requires a passphrase/i;

/** Waiting cannot fix these: a person must re-authenticate or verify the host first. */
export function isRemoteAgentReconnectStopFailure(cause: unknown): boolean {
  if (isDefinitiveReattachFailure(cause)) return true;
  const message = cause instanceof Error ? cause.message : String(cause);
  return CREDENTIAL_OR_HOST_TRUST.test(message);
}

/** Delay before attempt `attempt` (1-based, attempt 1 is immediate), with ±20% jitter. */
export function remoteAgentReconnectDelayMs(attempt: number, random: () => number): number {
  if (attempt <= 1) return 0;
  const base =
    REMOTE_AGENT_RECONNECT_DELAYS_MS[
      Math.min(attempt - 2, REMOTE_AGENT_RECONNECT_DELAYS_MS.length - 1)
    ]!;
  return Math.round(base * (0.8 + 0.4 * random()));
}

export interface RemoteAgentReconnectEpisodeInput<T> {
  readonly attempt: () => Promise<T>;
  /** Stop waiting (terminal closed or exited); resolves the episode as abandoned. */
  readonly cancelled: () => boolean;
  readonly delay?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly onRetry?: (attempt: number, cause: unknown) => void;
}

export type RemoteAgentReconnectEpisodeResult<T> =
  | { readonly status: "connected"; readonly value: T }
  | { readonly status: "stopped"; readonly cause: unknown }
  | { readonly status: "exhausted"; readonly cause: unknown }
  | { readonly status: "cancelled" };

/** Run one bounded reconnect episode. Each attempt re-reads identity; nothing is re-launched. */
export async function runRemoteAgentReconnectEpisode<T>(
  input: RemoteAgentReconnectEpisodeInput<T>,
): Promise<RemoteAgentReconnectEpisodeResult<T>> {
  const random = input.random ?? Math.random;
  const delay =
    input.delay ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }));
  let lastCause: unknown;
  for (let attempt = 1; attempt <= REMOTE_AGENT_RECONNECT_ATTEMPTS_PER_EPISODE; attempt += 1) {
    const wait = remoteAgentReconnectDelayMs(attempt, random);
    if (wait > 0) await delay(wait);
    if (input.cancelled()) return { status: "cancelled" };
    try {
      return { status: "connected", value: await input.attempt() };
    } catch (cause) {
      lastCause = cause;
      if (isRemoteAgentReconnectStopFailure(cause)) return { status: "stopped", cause };
      input.onRetry?.(attempt, cause);
    }
  }
  return { status: "exhausted", cause: lastCause };
}
