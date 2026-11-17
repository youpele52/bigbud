/**
 * Bounded HTTPS GET for release verification: one deadline across every hop and the body read,
 * a byte cap enforced while streaming, and redirects followed manually so each hop is checked
 * against an explicit host allowlist. Sends no cookies, credentials or identifying headers.
 */

export interface BoundedFetchOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly allowedHosts: ReadonlySet<string>;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxRedirects?: number;
}

export type BoundedFetchResult =
  | {
      readonly kind: "ok";
      readonly bytes: Buffer;
      readonly finalUrl: string;
      readonly contentType: string;
      readonly hops: string[];
    }
  | {
      readonly kind: "redirect-disallowed";
      readonly from: string;
      readonly location: string;
      readonly hops: string[];
    }
  | { readonly kind: "oversize"; readonly url: string; readonly limit: number }
  | { readonly kind: "unreachable"; readonly url: string; readonly reason: string };

export const DEFAULT_MAX_REDIRECTS = 5;

/** A generic, non-identifying client name. */
const REQUEST_HEADERS = { "user-agent": "bigbud-release-verifier", accept: "*/*" } as const;

class OversizeError extends Error {}

function isAllowedUrl(url: URL, allowedHosts: ReadonlySet<string>): boolean {
  return url.protocol === "https:" && url.username === "" && allowedHosts.has(url.hostname);
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw new OversizeError();
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new OversizeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function describeError(error: unknown, signal: AbortSignal, timeoutMs: number): string {
  if (signal.aborted) return `timed out after ${timeoutMs} ms`;
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    return `${error.message}${detail}`;
  }
  return String(error);
}

export async function boundedHttpsGet(
  startUrl: string,
  options: BoundedFetchOptions,
): Promise<BoundedFetchResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const hops: string[] = [startUrl];
  let current = new URL(startUrl);
  try {
    if (!isAllowedUrl(current, options.allowedHosts)) {
      return { kind: "redirect-disallowed", from: startUrl, location: startUrl, hops };
    }
    for (let redirects = 0; ; redirects += 1) {
      const response = await fetchImpl(current.href, {
        method: "GET",
        headers: REQUEST_HEADERS,
        redirect: "manual",
        credentials: "omit",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("location");
        if (!location) {
          return {
            kind: "unreachable",
            url: current.href,
            reason: `HTTP ${response.status} without a Location header`,
          };
        }
        const next = new URL(location, current);
        hops.push(next.href);
        if (!isAllowedUrl(next, options.allowedHosts)) {
          return { kind: "redirect-disallowed", from: current.href, location: next.href, hops };
        }
        if (redirects >= maxRedirects) {
          return {
            kind: "unreachable",
            url: current.href,
            reason: `more than ${maxRedirects} redirects`,
          };
        }
        current = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: "unreachable", url: current.href, reason: `HTTP ${response.status}` };
      }
      const bytes = await readCapped(response, options.maxBytes);
      const contentType = response.headers.get("content-type") ?? "";
      return { kind: "ok", bytes, finalUrl: current.href, contentType, hops };
    }
  } catch (error) {
    if (error instanceof OversizeError) {
      return { kind: "oversize", url: current.href, limit: options.maxBytes };
    }
    return {
      kind: "unreachable",
      url: current.href,
      reason: describeError(error, controller.signal, options.timeoutMs),
    };
  } finally {
    clearTimeout(timer);
  }
}
