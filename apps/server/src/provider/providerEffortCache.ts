import type { ProviderKind, ServerProvider } from "@bigbud/contracts";
import { Cause, Effect, FileSystem, Path } from "effect";

import { applyProviderEffortCache } from "./effortCache/effortCache.apply.ts";

/**
 * Decorate any provider snapshot with the last verified effort metadata while
 * keeping cache failures isolated from provider readiness.
 */
export function makeProviderEffortCacheDecorator<Settings>(input: {
  readonly provider: ProviderKind;
  readonly stateDir: string;
  readonly workspaceFingerprint: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly executionIdentity: (settings: Settings) => string;
  readonly configFingerprint?: (settings: Settings) => string;
}) {
  return (opts: {
    readonly settings: Settings;
    readonly snapshot: ServerProvider;
    readonly generation: number;
  }): Effect.Effect<ServerProvider> =>
    applyProviderEffortCache({
      snapshot: opts.snapshot,
      provider: input.provider,
      executionIdentity: input.executionIdentity(opts.settings),
      configFingerprint: input.configFingerprint?.(opts.settings) ?? JSON.stringify(opts.settings),
      workspaceFingerprint: input.workspaceFingerprint,
      stateDir: input.stateDir,
      generation: opts.generation,
      scopeKey: input.provider,
      persist: true,
      fileSystem: input.fileSystem,
      path: input.path,
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider effort capability cache unavailable", {
          provider: input.provider,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(opts.snapshot)),
      ),
    );
}
