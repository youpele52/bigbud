import {
  isRetryableHttpStatus,
  isTransientNetworkError,
  retryAfterMilliseconds,
  retryDelayMilliseconds,
  safeCauseErrorCode,
  safeDirectErrorCode,
  safeErrorName,
  type RemoteAgentDownloadPolicy,
} from "./remoteAgentHttpDownload.policy.ts";
import {
  defaultRemoteAgentDownloadLogger,
  logDownloadRuntimeOnce,
  makeDownloadOperationId,
  type RemoteAgentDownloadLogger,
} from "./remoteAgentHttpDownload.diagnostics.ts";
import {
  parseAndValidateDownloadUrl,
  sanitizedDownloadHost,
  type RemoteAgentDownloadUrlPolicy,
} from "./remoteAgentHttpDownload.url.ts";
import {
  makeRemoteAgentDownloadAttemptController,
  readRemoteAgentDownloadBody,
  remoteAgentDownloadSleep,
  RemoteAgentDownloadAttemptFailure as AttemptFailure,
  type RemoteAgentDownloadAbortOwner as AbortOwner,
  type RemoteAgentDownloadStage as DownloadStage,
} from "./remoteAgentHttpDownload.attempt.ts";

export class RemoteAgentDownloadError extends Error {
  readonly _tag = "RemoteAgentDownloadError";

  constructor(
    message: string,
    readonly details: {
      kind: RemoteAgentDownloadPolicy["kind"];
      stage: DownloadStage;
      attempts: number;
      elapsedMs: number;
      host: string;
      status?: number;
      abortOwner?: AbortOwner;
    },
  ) {
    super(message);
    this.name = "RemoteAgentDownloadError";
  }
}

export interface RemoteAgentHttpDownloadInput {
  readonly url: string;
  readonly policy: RemoteAgentDownloadPolicy;
  readonly expectedBytes?: number;
  readonly signal?: AbortSignal;
  readonly shutdownSignal?: AbortSignal;
  readonly urlPolicy?: RemoteAgentDownloadUrlPolicy;
  readonly operationId?: string;
}

export interface RemoteAgentHttpDownloadDependencies {
  readonly fetch?: RemoteAgentFetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly logger?: RemoteAgentDownloadLogger;
}

export type RemoteAgentFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function terminalMessage(input: {
  kind: RemoteAgentDownloadPolicy["kind"];
  stage: DownloadStage;
  attempts: number;
  elapsedMs: number;
  host: string;
  status?: number;
  abortOwner?: AbortOwner;
}): string {
  const status = input.status ? `, HTTP ${input.status}` : "";
  const abort = input.abortOwner ? `, abort=${input.abortOwner}` : "";
  return `Remote agent ${input.kind} download failed at ${input.stage} after ${input.attempts} attempt(s) and ${input.elapsedMs}ms from ${input.host}${status}${abort}.`;
}

async function runAttempt(input: {
  url: URL;
  urlPolicy: RemoteAgentDownloadUrlPolicy;
  policy: RemoteAgentDownloadPolicy;
  expectedBytes?: number;
  fetch: RemoteAgentFetch;
  signal: AbortSignal;
  abortOwner: () => AbortOwner | undefined;
  now: () => number;
}): Promise<{ bytes: Uint8Array; redirects: number; host: string; status: number }> {
  let current = input.url;
  const visited = new Set<string>();
  for (let redirects = 0; ; redirects += 1) {
    try {
      if (redirects > input.policy.maxRedirects || visited.has(current.href)) {
        throw new AttemptFailure("redirect", false);
      }
      visited.add(current.href);
      let response: Response;
      try {
        response = await input.fetch(current, { redirect: "manual", signal: input.signal });
      } catch (error) {
        const owner = input.abortOwner();
        throw new AttemptFailure(
          "request",
          owner === "attempt-timeout" || (!owner && isTransientNetworkError(error)),
          undefined,
          undefined,
          owner,
          { cause: error },
        );
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location) throw new AttemptFailure("redirect", false, response.status);
        try {
          current = parseAndValidateDownloadUrl(new URL(location, current).href, input.urlPolicy);
        } catch (error) {
          throw new AttemptFailure("redirect", false, response.status, undefined, undefined, {
            cause: error,
          });
        }
        continue;
      }
      if (!response.ok) {
        const retryable = isRetryableHttpStatus(response.status);
        await response.body?.cancel().catch(() => undefined);
        throw new AttemptFailure(
          "headers",
          retryable,
          response.status,
          retryable
            ? retryAfterMilliseconds(
                response.headers.get("retry-after"),
                input.now(),
                input.policy.maxRetryDelayMs,
              )
            : undefined,
        );
      }
      let bytes: Uint8Array;
      try {
        bytes = await readRemoteAgentDownloadBody(
          response,
          input.policy.maxBytes,
          input.expectedBytes,
        );
      } catch (error) {
        if (!(error instanceof AttemptFailure) || error.status !== undefined) throw error;
        const failure = new AttemptFailure(
          error.stage,
          error.retryable,
          response.status,
          error.retryAfterMs,
          error.abortOwner,
          { cause: error.cause },
        );
        failure.downloadedBytes = error.downloadedBytes;
        throw failure;
      }
      return {
        bytes,
        redirects,
        host: sanitizedDownloadHost(current),
        status: response.status,
      };
    } catch (error) {
      const owner = input.abortOwner();
      if (owner) {
        const failure = new AttemptFailure(
          error instanceof AttemptFailure ? error.stage : "body",
          owner === "attempt-timeout",
          error instanceof AttemptFailure ? error.status : undefined,
          undefined,
          owner,
          { cause: error },
        );
        failure.redirectCount = redirects;
        failure.hostname = sanitizedDownloadHost(current);
        failure.downloadedBytes =
          error instanceof AttemptFailure ? error.downloadedBytes : failure.downloadedBytes;
        throw failure;
      }
      if (error instanceof AttemptFailure) {
        error.redirectCount = redirects;
        error.hostname = sanitizedDownloadHost(current);
      }
      throw error;
    }
  }
}

export async function downloadRemoteAgentHttp(
  input: RemoteAgentHttpDownloadInput,
  dependencies: RemoteAgentHttpDownloadDependencies = {},
): Promise<Uint8Array> {
  const now = dependencies.now ?? Date.now;
  const fetchImplementation = dependencies.fetch ?? fetch;
  const sleep = dependencies.sleep ?? remoteAgentDownloadSleep;
  const random = dependencies.random ?? Math.random;
  const logger = dependencies.logger ?? defaultRemoteAgentDownloadLogger;
  const operationId = input.operationId ?? makeDownloadOperationId();
  const startedAt = now();
  const urlPolicy = input.urlPolicy ?? {};
  let initial: URL;
  try {
    initial = parseAndValidateDownloadUrl(input.url, urlPolicy);
  } catch {
    throw new RemoteAgentDownloadError(
      terminalMessage({
        kind: input.policy.kind,
        stage: "request",
        attempts: 0,
        elapsedMs: 0,
        host: "unapproved",
      }),
      { kind: input.policy.kind, stage: "request", attempts: 0, elapsedMs: 0, host: "unapproved" },
    );
  }
  const host = sanitizedDownloadHost(initial);
  logDownloadRuntimeOnce(logger, operationId, input.policy.kind);
  let lastFailure: AttemptFailure | undefined;
  let attemptsMade = 0;
  for (let attempt = 1; attempt <= input.policy.maxAttempts; attempt += 1) {
    const elapsed = now() - startedAt;
    const remaining = input.policy.overallTimeoutMs - elapsed;
    if (remaining <= 0) {
      lastFailure = new AttemptFailure("request", false, undefined, undefined, "overall-timeout");
      break;
    }
    const attemptStartedAt = now();
    attemptsMade = attempt;
    const controller = makeRemoteAgentDownloadAttemptController({
      ...(input.signal ? { caller: input.signal } : {}),
      ...(input.shutdownSignal ? { shutdown: input.shutdownSignal } : {}),
      attemptMs: Math.min(input.policy.attemptTimeoutMs, remaining),
      overallMs: remaining,
    });
    try {
      const result = await runAttempt({
        url: initial,
        urlPolicy,
        policy: input.policy,
        ...(input.expectedBytes === undefined ? {} : { expectedBytes: input.expectedBytes }),
        fetch: fetchImplementation,
        signal: controller.signal,
        abortOwner: controller.owner,
        now,
      });
      logger("remote agent download completed", {
        operationId,
        correlationId: operationId,
        kind: input.policy.kind,
        attempt,
        hostname: result.host,
        redirectCount: result.redirects,
        stage: "body",
        status: result.status,
        elapsedAttemptMs: now() - attemptStartedAt,
        elapsedOverallMs: now() - startedAt,
        bytes: result.bytes.byteLength,
      });
      return result.bytes;
    } catch (error) {
      lastFailure =
        error instanceof AttemptFailure
          ? error
          : new AttemptFailure(
              "request",
              isTransientNetworkError(error),
              undefined,
              undefined,
              undefined,
              { cause: error },
            );
      const canRetry = lastFailure.retryable && attempt < input.policy.maxAttempts;
      const delayMs =
        lastFailure.retryAfterMs ?? retryDelayMilliseconds(input.policy, attempt, random);
      logger("remote agent download attempt failed", {
        operationId,
        correlationId: operationId,
        kind: input.policy.kind,
        attempt,
        hostname: lastFailure.hostname ?? host,
        redirectCount: lastFailure.redirectCount,
        stage: lastFailure.stage,
        status: lastFailure.status,
        elapsedAttemptMs: now() - attemptStartedAt,
        elapsedOverallMs: now() - startedAt,
        bytes: lastFailure.downloadedBytes,
        retryClassification: lastFailure.retryable ? "transient" : "terminal",
        retryDecision: canRetry ? "retry" : "stop",
        retryDelayMs: canRetry ? delayMs : undefined,
        errorName: safeErrorName(lastFailure.cause),
        errorCode: safeDirectErrorCode(lastFailure.cause),
        causeCode: safeCauseErrorCode(lastFailure.cause),
        abortOwner: lastFailure.abortOwner,
      });
      if (!canRetry) break;
      const waitController = makeRemoteAgentDownloadAttemptController({
        ...(input.signal ? { caller: input.signal } : {}),
        ...(input.shutdownSignal ? { shutdown: input.shutdownSignal } : {}),
        attemptMs: input.policy.overallTimeoutMs,
        overallMs: Math.max(0, input.policy.overallTimeoutMs - (now() - startedAt)),
      });
      try {
        await sleep(delayMs, waitController.signal);
      } catch (error) {
        lastFailure = new AttemptFailure(
          "request",
          false,
          undefined,
          undefined,
          waitController.owner(),
          { cause: error },
        );
        break;
      } finally {
        waitController.close();
      }
    } finally {
      controller.close();
    }
  }
  const elapsedMs = now() - startedAt;
  const details = {
    kind: input.policy.kind,
    stage: lastFailure?.stage ?? "request",
    attempts: attemptsMade,
    elapsedMs,
    host: lastFailure?.hostname ?? host,
    ...(lastFailure?.status === undefined ? {} : { status: lastFailure.status }),
    ...(lastFailure?.abortOwner === undefined ? {} : { abortOwner: lastFailure.abortOwner }),
  };
  logger("remote agent download failed", {
    operationId,
    correlationId: operationId,
    kind: input.policy.kind,
    attempt: attemptsMade,
    hostname: lastFailure?.hostname ?? host,
    redirectCount: lastFailure?.redirectCount ?? 0,
    stage: details.stage,
    status: lastFailure?.status,
    elapsedAttemptMs: undefined,
    elapsedOverallMs: elapsedMs,
    bytes: lastFailure?.downloadedBytes ?? 0,
    retryClassification: lastFailure?.retryable ? "transient" : "terminal",
    retryDecision: "stop",
    retryDelayMs: undefined,
    errorName: safeErrorName(lastFailure?.cause),
    errorCode: safeDirectErrorCode(lastFailure?.cause),
    causeCode: safeCauseErrorCode(lastFailure?.cause),
    abortOwner: lastFailure?.abortOwner,
  });
  throw new RemoteAgentDownloadError(terminalMessage(details), details);
}
