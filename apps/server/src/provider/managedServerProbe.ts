import type { ProviderKind } from "@bigbud/contracts";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { Effect, Exit } from "effect";

import { ProviderAdapterProcessError } from "./Errors.ts";
import { OpencodeServerManager } from "./Services/Opencode/ServerManager.ts";

type ManagedServerProvider = Extract<ProviderKind, "opencode" | "kilocode">;
export const MANAGED_SERVER_PROVIDER_PROBE_TIMEOUT = "30 seconds";

export function withManagedServerProbe<A>(input: {
  readonly provider: ManagedServerProvider;
  readonly binaryPath: string;
  readonly invalidateOnRunFailure?: boolean;
  readonly run: (client: OpencodeClient) => Promise<A>;
}): Effect.Effect<A, ProviderAdapterProcessError, OpencodeServerManager> {
  return Effect.gen(function* () {
    const manager = yield* OpencodeServerManager;
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => manager.acquire({ provider: input.provider, binaryPath: input.binaryPath }),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: input.provider,
            threadId: "provider-check",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }),
      (handle) =>
        Effect.tryPromise({
          try: () => input.run(handle.client),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: input.provider,
              threadId: "provider-check",
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        }),
      (handle, exit) =>
        Effect.sync(() => {
          if (Exit.isFailure(exit) && input.invalidateOnRunFailure !== false) handle.invalidate();
          else handle.release();
        }),
    );
  });
}
