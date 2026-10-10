import { OpenCode, type OpenCodeClient } from "@opencode/client";

import { runWithAbortableDeadline } from "../../RequestDeadline.ts";
import { validateOwnedEndpoint } from "./Compatibility.ts";
import { boundV2Response, isV2ResponseSizeError, V2ResponseSizeError } from "./Client.response.ts";
import { V2_MEDIA_RESPONSE_BYTES } from "./Media.limits.ts";
import { V2HttpStatusError, v2HttpFailureStatus } from "./Client.errors.ts";

export type OpencodeV2Client = OpenCodeClient;

/** Owned and borrowed clients share origin/redirect/decode guards. */
export function makeOwnedClient(input: {
  readonly endpoint: string;
  readonly password: string;
  readonly fetch?: typeof globalThis.fetch;
}): OpencodeV2Client {
  return makeV2Client({
    ...input,
    headers: {
      authorization: `Basic ${Buffer.from(`opencode:${input.password}`).toString("base64")}`,
    },
  });
}

export function makeV2Client(input: {
  readonly endpoint: string;
  readonly headers?: Record<string, string> | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly beforeRequest?: () => Promise<void>;
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
      return fetchImplementation(request, { ...init, redirect: "error" }).then((response) => {
        // Native Location initialization may return an empty 500. Preserve status before SDK JSON decoding.
        if (response.status >= 500 && response.status <= 599) {
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
    return await runWithAbortableDeadline({
      operation,
      timeoutMs: options.timeoutMs ?? 10_000,
      ...(options.signal ? { signal: options.signal } : {}),
      run,
    });
  } catch (error) {
    if (isV2ResponseSizeError(error)) throw new V2ResponseSizeError();
    const status = v2HttpFailureStatus(error);
    if (status !== undefined) throw new V2HttpStatusError(status);
    throw new Error(`OpenCode v2 ${operation} failed or timed out; admission may be unconfirmed.`);
  }
}
