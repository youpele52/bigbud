import { isTransportConnectionErrorMessage } from "../../rpc/transportError";

export const RECOVERY_TRANSPORT_RETRY_DELAY_MS = 250;
export const MAX_RECOVERY_TRANSPORT_RETRIES = 20;

interface RetryTransportRecoveryOperationOptions {
  readonly delayMs?: number;
  readonly maxRetries?: number;
  readonly shouldAbort?: () => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function retryTransportRecoveryOperation<T>(
  operation: () => Promise<T>,
  options: RetryTransportRecoveryOperationOptions = {},
): Promise<T> {
  const delayMs = options.delayMs ?? RECOVERY_TRANSPORT_RETRY_DELAY_MS;
  const maxRetries = options.maxRetries ?? MAX_RECOVERY_TRANSPORT_RETRIES;
  const shouldAbort = options.shouldAbort ?? (() => false);
  const sleep = options.sleep ?? wait;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        shouldAbort() ||
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
