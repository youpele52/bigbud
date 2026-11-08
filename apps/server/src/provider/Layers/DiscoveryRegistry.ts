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
  Option,
  Path,
  PubSub,
  Ref,
  Schedule,
  Stream,
} from "effect";

import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../../startup/config";
import { ServerSettingsService } from "../../ws/serverSettings";
import { DiscoveryRegistry, type DiscoveryRegistryShape } from "../Services/DiscoveryRegistry";
import { ProviderRegistry } from "../Services/ProviderRegistry";
import {
  buildDiscoveryConfigDescriptors,
  buildDiscoveryFileDescriptors,
} from "./DiscoveryRegistry.descriptors.ts";
import {
  mergeEntries,
  parseDiscoveryFile,
  parseOpencodeConfigAgents,
} from "./DiscoveryRegistry.parse.ts";
import {
  resolveDiscoveryWatchTarget,
  runDiscoveryWatchTarget,
  type DiscoveryWatchTarget,
} from "./DiscoveryRegistry.watch.ts";
import { makeCoalescedDiscoverySync, type DiscoverySyncKind } from "./DiscoveryRegistry.sync.ts";
import { opencodeMarkdownAgentSystemHash } from "../opencodeAgentSource.ts";
import { buildNativeDiscoveryEntries } from "./DiscoveryRegistry.native.ts";

/** Bounds parallel directory walks and file reads during one discovery scan. */
const DISCOVERY_SCAN_CONCURRENCY = 8;
const DISCOVERY_READ_CONCURRENCY = 16;

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

export const haveDiscoveryChanged = (
  previousCatalog: ServerDiscoveryCatalog,
  nextCatalog: ServerDiscoveryCatalog,
): boolean => !Equal.equals(previousCatalog, nextCatalog);

const makeDiscoveryRegistry = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);
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
      const resolved = yield* Effect.forEach(
        [...new Set(candidates)],
        (candidate) => resolveDiscoveryWatchTarget(fs, path, candidate),
        { concurrency: DISCOVERY_SCAN_CONCURRENCY },
      );
      return resolved
        .filter((entry): entry is DiscoveryWatchTarget => entry !== null)
        .toSorted((left, right) => left.path.localeCompare(right.path));
    });

  const scanDiscoveryFiles = () =>
    Effect.gen(function* () {
      const allDescriptors = yield* resolveKnownFileDescriptors();
      const resolvedPaths = yield* Effect.forEach(
        allDescriptors,
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
        { concurrency: DISCOVERY_SCAN_CONCURRENCY },
      );
      const flat = resolvedPaths.flat();
      yield* Effect.logInfo(
        `[DiscoveryRegistry] scanDiscoveryFiles: ${flat.length} files found from ${allDescriptors.length} descriptors`,
      );
      return flat;
    });

  const scanDiscoveredFiles = () =>
    Effect.gen(function* () {
      const [fileDescriptors, configDescriptors] = yield* Effect.all(
        [scanDiscoveryFiles(), resolveConfigDescriptors()],
        { concurrency: "unbounded" },
      );

      const discoveredFileEntries = yield* Effect.forEach(
        fileDescriptors,
        (descriptor) =>
          fs.readFileString(descriptor.path).pipe(
            Effect.map((content) => {
              const parsed = parseDiscoveryFile({ ...descriptor, content });
              return {
                ...parsed,
                systemPromptHash:
                  parsed.kind === "agent" &&
                  descriptor.provider === "opencode" &&
                  /\.(md|markdown)$/i.test(descriptor.path)
                    ? opencodeMarkdownAgentSystemHash(content)
                    : undefined,
              };
            }),
            Effect.catch(() => Effect.succeed(null)),
          ),
        { concurrency: DISCOVERY_READ_CONCURRENCY },
      );

      const discoveredConfigAgents = yield* Effect.forEach(
        configDescriptors,
        (descriptor) =>
          fs.readFileString(descriptor.path).pipe(
            Effect.map((content) =>
              parseOpencodeConfigAgents(descriptor.path, content, descriptor.source),
            ),
            Effect.catch(() => Effect.succeed([] as ReadonlyArray<ServerDiscoveredAgent>)),
          ),
        { concurrency: DISCOVERY_READ_CONCURRENCY },
      );
      return { discoveredFileEntries, discoveredConfigAgents };
    });
  type DiscoveredFiles = Effect.Success<ReturnType<typeof scanDiscoveredFiles>>;

  const assembleCatalog = ({ discoveredFileEntries, discoveredConfigAgents }: DiscoveredFiles) =>
    Effect.gen(function* () {
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
      if (Option.isSome(providerRegistry)) {
        const providers = yield* providerRegistry.value.getProviders;
        const native = providers.find(
          (provider) => provider.provider === "opencodeV2" && provider.enabled,
        );
        const nativeCatalog = buildNativeDiscoveryEntries(native, discoveredFileEntries);
        agentEntries.push(...nativeCatalog.agents);
        skillEntries.push(...nativeCatalog.skills);
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

  // Provider status changes reuse the last scan: they change native entries, never files.
  const filesRef = yield* Ref.make<DiscoveredFiles | null>(null);
  const loadDiscoveryCatalog = (kind: DiscoverySyncKind = "rescan") =>
    Effect.gen(function* () {
      const cached = kind === "assemble" ? yield* Ref.get(filesRef) : null;
      const files = cached ?? (yield* scanDiscoveredFiles());
      yield* Ref.set(filesRef, files);
      return yield* assembleCatalog(files);
    });

  const catalogRef = yield* Ref.make<ServerDiscoveryCatalog>(yield* loadDiscoveryCatalog());

  const syncCatalog = (options?: {
    readonly publish?: boolean;
    readonly kind?: DiscoverySyncKind;
  }) =>
    Effect.gen(function* () {
      const previousCatalog = yield* Ref.get(catalogRef);
      const nextCatalog = yield* loadDiscoveryCatalog(options?.kind).pipe(
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

  // Every background trigger goes through one coalescing fiber: at most one sync runs and
  // one waits, however many watchers, settings or provider changes fire meanwhile.
  // Background syncs and explicit refreshes share one lock, so an `assemble` built from an
  // older scan can never finish after, and overwrite, a newer rescan.
  const syncLock = yield* Semaphore.make(1);
  const requestSync = yield* makeCoalescedDiscoverySync((kind) =>
    syncLock.withPermits(1)(syncCatalog({ kind })).pipe(Effect.asVoid),
  );
  yield* Stream.runForEach(serverSettings.streamChanges, () => requestSync("rescan")).pipe(
    Effect.forkScoped,
  );
  const watchTargets = yield* resolveWatchTargets();
  if (Option.isSome(providerRegistry))
    yield* Stream.runForEach(providerRegistry.value.streamChanges, () =>
      requestSync("assemble"),
    ).pipe(Effect.forkScoped);
  yield* Effect.logInfo(
    `[DiscoveryRegistry] watching ${watchTargets.length} roots for auto-discovery changes`,
  );
  yield* Effect.forEach(
    watchTargets,
    (target) => runDiscoveryWatchTarget(fs, target, requestSync("rescan")).pipe(Effect.forkScoped),
    { discard: true },
  );
  yield* Effect.forkScoped(
    Effect.repeat(requestSync("rescan"), Schedule.fixed(fallbackRescanInterval)),
  );

  return {
    getCatalog: Ref.get(catalogRef),
    refresh: (_provider?: ProviderKind) => syncLock.withPermits(1)(syncCatalog()),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies DiscoveryRegistryShape;
});

export const DiscoveryRegistryLive = Layer.effect(DiscoveryRegistry, makeDiscoveryRegistry);
