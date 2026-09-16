import type { ProviderKind, ServerProviderModel } from "@bigbud/contracts";
import { Effect, FileSystem, Path } from "effect";

import { makeEffortCacheIdentity } from "./effortCache.identity.ts";
import {
  overlayVerifiedEffortCache,
  verifiedEffortEntriesFromModels,
} from "./effortCache.merge.ts";
import {
  loadEffortCapabilityCache,
  peekEffortCapabilityCache,
  rememberEffortCacheEntries,
  saveEffortCapabilityCache,
} from "./effortCache.persist.ts";

export function overlayProviderEffortCache(input: {
  readonly stateDir: string;
  readonly provider: ProviderKind;
  readonly executionIdentity: string;
  readonly configFingerprint: string;
  readonly workspaceFingerprint: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
}): ReadonlyArray<ServerProviderModel> {
  const cache = peekEffortCapabilityCache(input.stateDir);
  return overlayVerifiedEffortCache({
    models: input.models,
    entries: cache.entries,
    identityFor: (model) =>
      makeEffortCacheIdentity({
        provider: input.provider,
        executionIdentity: input.executionIdentity,
        configFingerprint: input.configFingerprint,
        workspaceFingerprint: input.workspaceFingerprint,
        subProviderID: model.subProviderID,
        modelID: model.slug,
      }),
  });
}

export const applyProviderEffortCache = Effect.fn("applyProviderEffortCache")(function* (input: {
  readonly snapshot: import("@bigbud/contracts").ServerProvider;
  readonly provider: ProviderKind;
  readonly executionIdentity: string;
  readonly configFingerprint: string;
  readonly workspaceFingerprint: string;
  readonly stateDir: string;
  readonly generation: number;
  readonly persist?: boolean;
  readonly scopeKey?: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  yield* loadEffortCapabilityCache(input);
  const models = overlayProviderEffortCache({
    stateDir: input.stateDir,
    provider: input.provider,
    executionIdentity: input.executionIdentity,
    configFingerprint: input.configFingerprint,
    workspaceFingerprint: input.workspaceFingerprint,
    models: input.snapshot.models,
  });
  if (input.persist !== false) {
    rememberProviderEffortCache({ ...input, models });
    yield* saveEffortCapabilityCache({
      fileSystem: input.fileSystem,
      path: input.path,
      stateDir: input.stateDir,
      generation: input.generation,
      ...(input.scopeKey ? { scopeKey: input.scopeKey } : {}),
    });
  }
  return { ...input.snapshot, models };
});

export function rememberProviderEffortCache(input: {
  readonly stateDir: string;
  readonly provider: ProviderKind;
  readonly executionIdentity: string;
  readonly configFingerprint: string;
  readonly workspaceFingerprint: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly generation: number;
  readonly verifiedAt?: string;
  readonly scopeKey?: string;
}): void {
  rememberEffortCacheEntries({
    stateDir: input.stateDir,
    generation: input.generation,
    entries: verifiedEffortEntriesFromModels({
      models: input.models,
      generation: input.generation,
      verifiedAt: input.verifiedAt ?? new Date().toISOString(),
      identityFor: (model) =>
        makeEffortCacheIdentity({
          provider: input.provider,
          executionIdentity: input.executionIdentity,
          configFingerprint: input.configFingerprint,
          workspaceFingerprint: input.workspaceFingerprint,
          subProviderID: model.subProviderID,
          modelID: model.slug,
        }),
    }),
    ...(input.scopeKey ? { scopeKey: input.scopeKey } : {}),
  });
}

export const hydrateAndPersistProviderEffortCache = Effect.fn(
  "hydrateAndPersistProviderEffortCache",
)(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly stateDir: string;
  readonly provider: ProviderKind;
  readonly executionIdentity: string;
  readonly configFingerprint: string;
  readonly workspaceFingerprint: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly generation: number;
  readonly scopeKey?: string;
}) {
  yield* loadEffortCapabilityCache(input);
  const models = overlayProviderEffortCache(input);
  rememberProviderEffortCache({ ...input, models });
  yield* saveEffortCapabilityCache(input);
  return models;
});
