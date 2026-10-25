import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { Service } from "@opencode/client/service";
import {
  assertV2RequestContext,
  currentV2RequestContext,
  assertV2OperationCurrent,
} from "./Client.guard.ts";
import { assertV2OrchestrationRpc } from "./Client.guard.orchestration.ts";
import { guardV2CallerFetch } from "./Runtime.caller.ts";

import { runWithAbortableDeadline } from "../../RequestDeadline.ts";
import { validateOwnedEndpoint } from "./Compatibility.ts";
import { boundV2Response, isV2ResponseSizeError, V2ResponseSizeError } from "./Client.response.ts";
import { V2_MEDIA_RESPONSE_BYTES } from "./Media.limits.ts";
import { V2HttpStatusError, v2HttpFailureStatus } from "./Client.errors.ts";
import { logV2RequestFailure, V2RequestFailedError } from "./Client.diagnostics.ts";

export type OpencodeV2Client = OpenCodeClient;

/** Owned and borrowed clients share origin/redirect/decode guards. */
export function makeOwnedClient(input: {
  readonly endpoint: string;
  readonly password: string;
  readonly fetch?: typeof globalThis.fetch;
}): OpencodeV2Client {
  return makeV2Client({
    ...input,
    headers: Service.headers({
      url: input.endpoint,
      auth: { type: "basic", username: "opencode", password: input.password },
    }),
  });
}

export function makeV2Client(input: {
  readonly endpoint: string;
  readonly headers?: Record<string, string> | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly beforeRequest?: () => Promise<void>;
  readonly sharedTransport?: string;
}): OpencodeV2Client {
  const origin = validateOwnedEndpoint(input.endpoint);
  const fetchImplementation = input.fetch ?? globalThis.fetch;
  const guardedFetch: typeof globalThis.fetch = Object.assign(
    async (request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(request instanceof Request ? request.url : String(request));
      if (url.origin !== origin || url.username || url.password) {
        return Promise.reject(new Error("OpenCode v2 request origin rejected."));
      }
      await input.beforeRequest?.();
      const context = input.sharedTransport
        ? assertV2RequestContext(
            input.sharedTransport,
            url,
            init?.method ?? (request instanceof Request ? request.method : "GET"),
          )
        : undefined;
      if (context && url.pathname.startsWith("/api/rpc/"))
        await assertV2OrchestrationRpc(context, url, request, init);
      const originalSignal =
        init?.signal ?? (request instanceof Request ? request.signal : undefined);
      const signal = context
        ? AbortSignal.any([context.permit.signal, ...(originalSignal ? [originalSignal] : [])])
        : originalSignal;
      signal?.throwIfAborted();
      currentV2RequestContext()?.operationSignal?.throwIfAborted();
      assertV2OperationCurrent();
      if (currentV2RequestContext()?.intent !== "cleanup")
        guardV2CallerFetch(
          url,
          init?.method ?? (request instanceof Request ? request.method : "GET"),
        );
      return fetchImplementation(request, {
        ...init,
        ...(signal ? { signal } : {}),
        redirect: "error",
      }).then((response) => {
        try {
          context?.permit.assertCurrent();
        } catch (error) {
          void response.body?.cancel().catch(() => {});
          throw error;
        }
        // Native Location initialization may return an empty 500. Preserve status before SDK JSON decoding.
        if (response.status >= 400 && response.status <= 599) {
          void response.body?.cancel().catch(() => {});
          throw new V2HttpStatusError(response.status);
        }
        // Only media-bearing endpoints gain a larger bounded decode window. Hub queues retain their smaller overflow/repair fence.
        return boundV2Response(
          response,
          /\/(?:event|message|inbox)(?:\/|$)|\/prompt$/.test(url.pathname)
            ? V2_MEDIA_RESPONSE_BYTES
            : undefined,
        );
      });
    },
    {
      preconnect: (...args: Parameters<typeof fetch.preconnect>) =>
        fetchImplementation.preconnect?.(...args),
    },
  );
  return OpenCode.make({
    baseUrl: origin,
    headers: input.headers,
    fetch: guardedFetch,
  });
}

/** Preserve only safe operation diagnostics; SDK exceptions can contain request data. */
export async function v2Request<T>(
  operation: string,
  run: (signal: AbortSignal) => Promise<T>,
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<T> {
  try {
    const context = currentV2RequestContext();
    context?.permit.assertCurrent();
    const signal = context
      ? AbortSignal.any([
          context.permit.signal,
          ...(context.operationSignal ? [context.operationSignal] : []),
          ...(options.signal ? [options.signal] : []),
        ])
      : options.signal;
    const result = await runWithAbortableDeadline({
      operation,
      timeoutMs: options.timeoutMs ?? 10_000,
      ...(signal ? { signal } : {}),
      run: (abort) => {
        assertV2OperationCurrent();
        const physical = run(abort);
        context?.observeOperation?.(physical);
        return physical;
      },
    });
    context?.permit.assertCurrent();
    return result;
  } catch (error) {
    if (isV2ResponseSizeError(error)) throw new V2ResponseSizeError();
    const status = v2HttpFailureStatus(error);
    if (status !== undefined) throw new V2HttpStatusError(status, operation);
    const context = currentV2RequestContext();
    logV2RequestFailure(operation, error, {
      consentAborted: context?.permit.signal.aborted ?? false,
      operationAborted: context?.operationSignal?.aborted ?? false,
      callerAborted: options.signal?.aborted ?? false,
    });
    // oxlint-disable-next-line preserve-caught-error -- Native SDK causes may retain credentials or request contents.
    throw new V2RequestFailedError(operation, error);
  }
}
