import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import type { ServerProviderUsageLimits } from "@bigbud/contracts/server/usageLimits.ts";
import { Effect } from "effect";
import { createHash } from "node:crypto";
import { usageLimitsStatus, type UsageLimitsSource } from "./providerUsageLimits.ts";

export interface UsageCredential {
  readonly secret: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Keeps optional account quota reads bounded, scoped, and separate from provider health. */
export function makeHttpUsageLimitsReader(input: {
  readonly source: UsageLimitsSource;
  readonly url: string;
  readonly loadCredential: () => Promise<UsageCredential | undefined>;
  readonly normalize: (value: unknown, checkedAt: string) => ServerProviderUsageLimits;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}) {
  let retained: { scope: string; limits: ServerProviderUsageLimits } | undefined;
  let cached: { scope: string; limits: ServerProviderUsageLimits; expiresAt: number } | undefined;

  return async function readUsageLimits(signal: AbortSignal): Promise<ServerProviderUsageLimits> {
    const checkedAt = new Date().toISOString();
    let scope: string | undefined;
    try {
      const credential = await input.loadCredential();
      signal.throwIfAborted();
      if (!credential) {
        retained = undefined;
        cached = undefined;
        return usageLimitsStatus(input.source, checkedAt, "unavailable");
      }
      // The fingerprint is private to this reader and is never sent to clients or logs.
      scope = createHash("sha256").update(credential.secret).digest("hex");
      if (retained?.scope !== scope) retained = undefined;
      if (cached?.scope === scope && cached.expiresAt > Date.now()) return cached.limits;
      const response = await (input.fetch ?? fetch)(input.url, {
        headers: { Accept: "application/json", "User-Agent": "bigbud", ...credential.headers },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(input.timeoutMs ?? 5_000)]),
      });
      let limits: ServerProviderUsageLimits;
      if ([401, 403, 404].includes(response.status)) {
        await response.body?.cancel();
        limits = usageLimitsStatus(input.source, checkedAt, "unavailable");
      } else {
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("Usage request failed.");
        }
        limits = input.normalize(await readBoundedUsageJson(response), checkedAt);
      }
      signal.throwIfAborted();
      retained = limits.status === "available" ? { scope, limits } : undefined;
      cached = { scope, limits, expiresAt: Date.now() + 60_000 };
      return limits;
    } catch {
      signal.throwIfAborted();
      const error = usageLimitsStatus(input.source, checkedAt, "error");
      const limits =
        scope && retained?.scope === scope
          ? {
              ...retained.limits,
              status: "stale" as const,
              checkedAt,
              message: error.message,
            }
          : error;
      if (scope) cached = { scope, limits, expiresAt: Date.now() + 15_000 };
      return limits;
    }
  };
}

/** Applies quota without allowing a missing session or remote failure to change CLI health. */
export const withHttpUsageLimits = Effect.fn("withHttpUsageLimits")(function* (
  snapshot: ServerProvider,
  read: (signal: AbortSignal) => Promise<ServerProviderUsageLimits>,
) {
  if (!snapshot.enabled || !snapshot.installed || snapshot.auth.status === "unauthenticated")
    return snapshot;
  const usageLimits = yield* Effect.tryPromise((signal) => read(signal)).pipe(
    Effect.tap((limits) =>
      limits.status === "error" || limits.status === "stale"
        ? Effect.logWarning("Subscription limits could not be refreshed", { source: limits.source })
        : Effect.void,
    ),
    Effect.orElseSucceed(() => undefined),
  );
  return { ...snapshot, ...(usageLimits ? { usageLimits } : {}) };
});

async function readBoundedUsageJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing usage response.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 256 * 1024) throw new Error("Usage response exceeds size limit.");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
