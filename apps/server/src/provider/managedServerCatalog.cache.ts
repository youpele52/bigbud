import type { ProviderKind, ServerProvider } from "@bigbud/contracts";
import { Effect, FileSystem, Path } from "effect";

import { applyProviderEffortCache } from "./effortCache/effortCache.apply.ts";

export const applyManagedProviderEffortCache = Effect.fn("applyManagedProviderEffortCache")(
  function* (input: {
    readonly snapshot: ServerProvider;
    readonly provider: Extract<ProviderKind, "kilocode" | "opencode">;
    readonly binaryPath: string;
    readonly customModels: ReadonlyArray<string>;
    readonly workspace: string;
    readonly stateDir: string;
    readonly generation: number;
    readonly persist: boolean;
    readonly scopeKey?: string;
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
  }) {
    return yield* applyProviderEffortCache({
      snapshot: input.snapshot,
      provider: input.provider,
      executionIdentity: input.binaryPath,
      configFingerprint: JSON.stringify({ customModels: input.customModels }),
      workspaceFingerprint: input.workspace,
      stateDir: input.stateDir,
      generation: input.generation,
      persist: input.persist,
      ...(input.scopeKey ? { scopeKey: input.scopeKey } : {}),
      fileSystem: input.fileSystem,
      path: input.path,
    });
  },
);
