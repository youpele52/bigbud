import type {
  ServerGetThreadRetentionRunInput,
  ServerThreadRetentionRun,
} from "@bigbud/contracts/server/threadRetention";

import { isTransportConnectionErrorMessage } from "./transportError";

export const THREAD_RETENTION_POLL_MAX_RETRIES = 4;
export const THREAD_RETENTION_POLL_INITIAL_RETRY_DELAY_MS = 500;
export const THREAD_RETENTION_POLL_MAX_RETRY_DELAY_MS = 4_000;

interface ThreadRetentionPollingOptions {
  readonly signal?: AbortSignal;
  readonly maxRetries?: number;
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

function abortError(): DOMException {
  return new DOMException("Thread retention polling was cancelled.", "AbortError");
}

function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const timeoutId = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", cancel, { once: true });

    function finish() {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }

    function cancel() {
      clearTimeout(timeoutId);
      reject(abortError());
    }
  });
}

function isTransientGetRunError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    isTransportConnectionErrorMessage(message) ||
    message.includes("Failed to load the retention run") ||
    message.includes("temporarily unavailable")
  );
}

export function getThreadRetentionPollRetryDelayMs(failedAttempt: number): number {
  return Math.min(
    THREAD_RETENTION_POLL_INITIAL_RETRY_DELAY_MS * 2 ** failedAttempt,
    THREAD_RETENTION_POLL_MAX_RETRY_DELAY_MS,
  );
}

export async function getThreadRetentionRunWithRetry(
  getRun: (input: ServerGetThreadRetentionRunInput) => Promise<ServerThreadRetentionRun>,
  input: ServerGetThreadRetentionRunInput,
  options: ThreadRetentionPollingOptions = {},
): Promise<ServerThreadRetentionRun> {
  const maxRetries = options.maxRetries ?? THREAD_RETENTION_POLL_MAX_RETRIES;
  const sleep = options.sleep ?? abortableSleep;

  for (let attempt = 0; ; attempt += 1) {
    if (options.signal?.aborted) throw abortError();

    try {
      return await getRun(input);
    } catch (error) {
      if (options.signal?.aborted || !isTransientGetRunError(error) || attempt >= maxRetries) {
        throw error;
      }

      await sleep(getThreadRetentionPollRetryDelayMs(attempt), options.signal);
    }
  }
}

export function isThreadRetentionPollingAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
