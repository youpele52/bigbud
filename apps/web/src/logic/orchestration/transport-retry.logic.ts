import { isTransportConnectionErrorMessage } from "../../rpc/transportError";

export const RECOVERY_TRANSPORT_RETRY_DELAY_MS = 250;
export const MAX_RECOVERY_TRANSPORT_RETRIES = 20;
export const RECOVERY_OPERATION_TIMEOUT_MS = 15_000;

interface RetryTransportRecoveryOperationOptions {
  readonly delayMs?: number;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
  readonly shouldAbort?: () => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class OrchestrationRecoveryTimeoutError extends Error {
  constructor() {
    super("Orchestration recovery operation timed out");
    this.name = "OrchestrationRecoveryTimeoutError";
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return operation;
  }
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<T>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new OrchestrationRecoveryTimeoutError());
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  });
}

export async function retryTransportRecoveryOperation<T>(
  operation: () => Promise<T>,
  options: RetryTransportRecoveryOperationOptions = {},
): Promise<T> {
  const delayMs = options.delayMs ?? RECOVERY_TRANSPORT_RETRY_DELAY_MS;
  const maxRetries = options.maxRetries ?? MAX_RECOVERY_TRANSPORT_RETRIES;
  const timeoutMs = options.timeoutMs;
  const shouldAbort = options.shouldAbort ?? (() => false);
  const sleep = options.sleep ?? wait;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await (timeoutMs === undefined ? operation() : withTimeout(operation(), timeoutMs));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        shouldAbort() ||
        error instanceof OrchestrationRecoveryTimeoutError ||
        !isTransportConnectionErrorMessage(message) ||
        attempt >= maxRetries - 1
      ) {
        throw error;
      }

      await sleep(delayMs);
      if (shouldAbort()) {
        throw error;
      }
    }
  }
}
