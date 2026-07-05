import type {
  ProviderKind,
  ServerDiscoveredAgent,
  ServerDiscoveredSkill,
  ServerDiscoveryCatalog,
} from "@bigbud/contracts";
import {
  Duration,
  Effect,
  Equal,
  FileSystem,
  Layer,
  Path,
  PubSub,
  Ref,
  Schedule,
  Stream,
} from "effect";

import { ServerConfig } from "../../startup/config";
import { ServerSettingsService } from "../../ws/serverSettings";
import { DiscoveryRegistry, type DiscoveryRegistryShape } from "../Services/DiscoveryRegistry";
import {
  buildDiscoveryConfigDescriptors,
  buildDiscoveryFileDescriptors,
} from "./DiscoveryRegistry.descriptors.ts";
import {
  mergeEntries,
  parseDiscoveryFile,
  parseOpencodeConfigAgents,
} from "./DiscoveryRegistry.parse.ts";
import { createDiscoveryWatchStream } from "./DiscoveryRegistry.watch.ts";

const EMPTY_DISCOVERY: ServerDiscoveryCatalog = {
  agents: [],
  skills: [],
};

function resolveDiscoveryFallbackRescanInterval(): Duration.Duration {
  const rawIntervalMs = process.env.BIGBUD_DISCOVERY_FALLBACK_RESCAN_MS?.trim();
  const parsedMs = rawIntervalMs ? Number.parseInt(rawIntervalMs, 10) : Number.NaN;
  if (Number.isFinite(parsedMs) && parsedMs > 0) {
    return Duration.millis(parsedMs);
  }
  return Duration.minutes(2);
}

const collectPathsRecursive = Effect.fn("DiscoveryRegistry.collectPathsRecursive")(function* (
  fs: FileSystem.FileSystem,
  rootPath: string,
  predicate: (path: string) => boolean,
) {
  const exists = yield* fs.exists(rootPath).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("DiscoveryRegistry: exists check failed", {
        rootPath,
        error: String(error),
      }),
    ),
    Effect.orElseSucceed(() => false),
  );
  if (!exists) {
    return [] as Array<string>;
  }
  const entries = yield* fs.readDirectory(rootPath, { recursive: true }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("DiscoveryRegistry: readDirectory failed", {
        rootPath,
        error: String(error),
      }),
    ),
    Effect.orElseSucceed(() => [] as Array<string>),
  );
  return entries
    .map((entry) => `${rootPath}/${entry}`.replace(/\/+/g, "/"))
    .filter((p) => !p.split("/").includes("node_modules"))
    .filter(predicate);
});

export const resolveExistingWatchPath = Effect.fn("DiscoveryRegistry.resolveExistingWatchPath")(
  function* (fs: FileSystem.FileSystem, path: Path.Path, rawPath: string) {
    // Avoid recursively watching broad system roots for optional descriptors.
    if (rawPath.startsWith("/etc/")) {
      const exists = yield* fs.exists(rawPath).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("DiscoveryRegistry: watch path exists check failed", {
            path: rawPath,
            error: String(error),
          }),
        ),
        Effect.orElseSucceed(() => false),
      );
      return exists ? rawPath : null;
    }

    const candidates = [rawPath];
    const parentPath = path.dirname(rawPath);
    if (parentPath !== rawPath) {
      candidates.push(parentPath);
    }

    for (const currentPath of candidates) {
      const exists = yield* fs.exists(currentPath).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("DiscoveryRegistry: watch path exists check failed", {
            path: currentPath,
            error: String(error),
          }),
        ),
        Effect.orElseSucceed(() => false),
      );
      if (exists) {
        return currentPath;
      }
    }

    return null;
  },
);

export const haveDiscoveryChanged = (
  previousCatalog: ServerDiscoveryCatalog,
  nextCatalog: ServerDiscoveryCatalog,
): boolean => !Equal.equals(previousCatalog, nextCatalog);

const makeDiscoveryRegistry = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const fallbackRescanInterval = resolveDiscoveryFallbackRescanInterval();
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ServerDiscoveryCatalog>(),
    PubSub.shutdown,
  );

  const resolveKnownFileDescriptors = () =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      return buildDiscoveryFileDescriptors({
        path,
        cwd: config.cwd,
        settings,
      });
    });

  const resolveConfigDescriptors = () =>
    Effect.succeed(
      buildDiscoveryConfigDescriptors({
        path,
        cwd: config.cwd,
      }),
    );

  const resolveWatchTargets = () =>
    Effect.gen(function* () {
      const [fileDescriptors, configDescriptors] = yield* Effect.all(
        [resolveKnownFileDescriptors(), resolveConfigDescriptors()],
        { concurrency: "unbounded" },
      );
      const candidates = [
        ...fileDescriptors.map((entry) => entry.path),
        ...configDescriptors.map((entry) => entry.path),
      ];
      const existingPaths = yield* Effect.forEach(
        candidates,
        (candidate) => resolveExistingWatchPath(fs, path, candidate),
        { concurrency: "unbounded" },
      );
      return [
        ...new Set(existingPaths.filter((entry): entry is string => entry !== null)),
      ].toSorted((left, right) => left.localeCompare(right));
    });

  const scanDiscoveryFiles = () =>
    Effect.gen(function* () {
      const descriptors = yield* resolveKnownFileDescriptors();
      const resolvedPaths = yield* Effect.forEach(
        descriptors,
        (descriptor) =>
          collectPathsRecursive(fs, descriptor.path, (absolutePath) => {
            if (descriptor.kind === "skill") {
              return /\/(?:SKILL|skill)\.md$/u.test(absolutePath);
            }
            return /\.(md|markdown|json|toml|ya?ml)$/i.test(absolutePath);
          }).pipe(
            Effect.map((paths) =>
              paths.map((resolvedPath) => ({ ...descriptor, path: resolvedPath })),
            ),
          ),
        { concurrency: "unbounded" },
      );
      const flat = resolvedPaths.flat();
      yield* Effect.logInfo(
        `[DiscoveryRegistry] scanDiscoveryFiles: ${flat.length} files found from ${descriptors.length} descriptors`,
      );
      return flat;
    });

  const loadDiscoveryCatalog = () =>
    Effect.gen(function* () {
      const [fileDescriptors, configDescriptors] = yield* Effect.all(
        [scanDiscoveryFiles(), resolveConfigDescriptors()],
        { concurrency: "unbounded" },
      );

      const discoveredFileEntries = yield* Effect.forEach(
        fileDescriptors,
        (descriptor) =>
          fs.readFileString(descriptor.path).pipe(
            Effect.map((content) => parseDiscoveryFile({ ...descriptor, content })),
            Effect.catch(() => Effect.succeed(null)),
          ),
        { concurrency: "unbounded" },
      );

      const discoveredConfigAgents = yield* Effect.forEach(
        configDescriptors,
        (descriptor) =>
          fs.readFileString(descriptor.path).pipe(
            Effect.map((content) => parseOpencodeConfigAgents(descriptor.path, content)),
            Effect.catch(() => Effect.succeed([] as ReadonlyArray<ServerDiscoveredAgent>)),
          ),
        { concurrency: "unbounded" },
      );

      const agentEntries: Array<ServerDiscoveredAgent> = [];
      const skillEntries: Array<ServerDiscoveredSkill> = [];

      for (const entry of discoveredFileEntries) {
        if (!entry) {
          continue;
        }
        if (entry.kind === "agent") {
          agentEntries.push(entry.entry as ServerDiscoveredAgent);
          continue;
        }
        skillEntries.push(entry.entry as ServerDiscoveredSkill);
      }

      for (const entries of discoveredConfigAgents) {
        agentEntries.push(...entries);
      }

      const catalog = {
        agents: mergeEntries(agentEntries),
        skills: mergeEntries(skillEntries),
      } satisfies ServerDiscoveryCatalog;

      yield* Effect.logInfo(
        `[DiscoveryRegistry] loadDiscoveryCatalog: ${catalog.skills.length} skills, ${catalog.agents.length} agents`,
      );

      return catalog;
    });

  const catalogRef = yield* Ref.make<ServerDiscoveryCatalog>(yield* loadDiscoveryCatalog());

  const syncCatalog = (options?: { readonly publish?: boolean }) =>
    Effect.gen(function* () {
      const previousCatalog = yield* Ref.get(catalogRef);
      const nextCatalog = yield* loadDiscoveryCatalog().pipe(
        Effect.tapError((error) =>
          Effect.logWarning("DiscoveryRegistry: syncCatalog load failed", {
            error: String(error),
          }),
        ),
        Effect.catch(() => Effect.succeed(EMPTY_DISCOVERY)),
      );
      yield* Ref.set(catalogRef, nextCatalog);
      if (options?.publish !== false && haveDiscoveryChanged(previousCatalog, nextCatalog)) {
        yield* PubSub.publish(changesPubSub, nextCatalog);
      }
      return nextCatalog;
    });

  yield* Stream.runForEach(serverSettings.streamChanges, () => syncCatalog()).pipe(
    Effect.forkScoped,
  );
  const watchTargets = yield* resolveWatchTargets();
  yield* Effect.logInfo(
    `[DiscoveryRegistry] watching ${watchTargets.length} roots for auto-discovery changes`,
  );
  yield* Effect.forEach(
    watchTargets,
    (watchPath) =>
      Stream.runForEach(createDiscoveryWatchStream(watchPath), () => syncCatalog()).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("DiscoveryRegistry: watch stream failed", {
            watchPath,
            error: String(error),
          }),
        ),
        Effect.catch(() => Effect.void),
        Effect.forkScoped,
      ),
    { concurrency: "unbounded" },
  ).pipe(Effect.asVoid);
  yield* Effect.forkScoped(Effect.repeat(syncCatalog(), Schedule.fixed(fallbackRescanInterval)));

  return {
    getCatalog: syncCatalog({ publish: false }),
    refresh: (_provider?: ProviderKind) => syncCatalog(),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies DiscoveryRegistryShape;
});

export const DiscoveryRegistryLive = Layer.effect(DiscoveryRegistry, makeDiscoveryRegistry);
