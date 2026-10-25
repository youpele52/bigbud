import type { CodexSettings } from "@bigbud/contracts/core/settings.ts";
import { Effect } from "effect";
import { probeCodexDiscovery } from "../../codexAppServer.ts";
import { usageLimitsStatus } from "../../providerUsageLimits.ts";

/** Uses a short-lived read-only probe, never a running conversation's app-server. */
export const readCodexSubscriptionUsage = Effect.fn("readCodexSubscriptionUsage")(function* (
  settings: CodexSettings,
) {
  return yield* Effect.tryPromise((signal) =>
    probeCodexDiscovery({
      binaryPath: settings.binaryPath,
      ...(settings.homePath ? { homePath: settings.homePath } : {}),
      cwd: process.cwd(),
      signal,
      includeUsageLimits: true,
      usageOnly: true,
    }),
  ).pipe(
    Effect.timeout("8 seconds"),
    Effect.map(
      (result) =>
        result.usageLimits ??
        usageLimitsStatus("codex-app-server", new Date().toISOString(), "unavailable"),
    ),
    Effect.orElseSucceed(() =>
      usageLimitsStatus("codex-app-server", new Date().toISOString(), "error"),
    ),
  );
});
