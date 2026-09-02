import {
  isTransientNetworkError,
  type RemoteAgentDownloadAbortOwner,
} from "./remoteAgentHttpDownload.policy.ts";

export type RemoteAgentDownloadStage = "request" | "headers" | "redirect" | "body";
export type { RemoteAgentDownloadAbortOwner } from "./remoteAgentHttpDownload.policy.ts";

export class RemoteAgentDownloadAttemptFailure extends Error {
  redirectCount = 0;
  downloadedBytes = 0;
  hostname?: string;

  constructor(
    readonly stage: RemoteAgentDownloadStage,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number,
    readonly abortOwner?: RemoteAgentDownloadAbortOwner,
    options?: ErrorOptions,
  ) {
    super("download attempt failed", options);
  }
}

export function remoteAgentDownloadSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function makeRemoteAgentDownloadAttemptController(input: {
  caller?: AbortSignal;
  shutdown?: AbortSignal;
  attemptMs: number;
  overallMs: number;
}) {
  const controller = new AbortController();
  let owner: RemoteAgentDownloadAbortOwner | undefined;
  const abort = (nextOwner: RemoteAgentDownloadAbortOwner) => {
    if (controller.signal.aborted) return;
    owner = nextOwner;
    controller.abort(new DOMException(nextOwner, "AbortError"));
  };
  const listeners: Array<readonly [AbortSignal, () => void]> = [];
  for (const [signal, signalOwner] of [
    [input.caller, "caller"],
    [input.shutdown, "shutdown"],
  ] as const) {
    if (!signal) continue;
    const listener = () => abort(signalOwner);
    if (signal.aborted) listener();
    else signal.addEventListener("abort", listener, { once: true });
    listeners.push([signal, listener]);
  }
  const attemptTimer =
    input.attemptMs < input.overallMs
      ? setTimeout(() => abort("attempt-timeout"), input.attemptMs)
      : undefined;
  const overallTimer = setTimeout(() => abort("overall-timeout"), input.overallMs);
  return {
    signal: controller.signal,
    owner: () => owner,
    close: () => {
      if (attemptTimer) clearTimeout(attemptTimer);
      clearTimeout(overallTimer);
      for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
    },
  };
}

export async function cancelRemoteAgentResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup must not replace the response validation failure.
  }
}

export async function readRemoteAgentDownloadBody(
  response: Response,
  maximum: number,
  expectedBytes?: number,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maximum) {
      await cancelRemoteAgentResponseBody(response);
      throw new RemoteAgentDownloadAttemptFailure("headers", false);
    }
    if (expectedBytes !== undefined && declared !== expectedBytes) {
      await cancelRemoteAgentResponseBody(response);
      throw new RemoteAgentDownloadAttemptFailure("headers", false);
    }
  }
  if (!response.body) throw new RemoteAgentDownloadAttemptFailure("body", false);
  const limit = expectedBytes ?? maximum;
  const expectedBuffer = expectedBytes === undefined ? undefined : new Uint8Array(expectedBytes);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      const offset = total;
      total += chunk.byteLength;
      if (total > limit) {
        const failure = new RemoteAgentDownloadAttemptFailure("body", false);
        failure.downloadedBytes = total;
        throw failure;
      }
      if (expectedBuffer) expectedBuffer.set(chunk, offset);
      else chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof RemoteAgentDownloadAttemptFailure) throw error;
    const failure = new RemoteAgentDownloadAttemptFailure(
      "body",
      isTransientNetworkError(error),
      undefined,
      undefined,
      undefined,
      { cause: error },
    );
    failure.downloadedBytes = total;
    throw failure;
  }
  if (total === 0 || (expectedBytes !== undefined && total !== expectedBytes)) {
    const failure = new RemoteAgentDownloadAttemptFailure("body", false);
    failure.downloadedBytes = total;
    throw failure;
  }
  if (expectedBuffer) return expectedBuffer;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
