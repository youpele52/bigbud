import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Cause, Effect, Layer, PubSub, Ref, Schema, Stream } from "effect";
import { PluginError, type PluginCatalog, type PluginCatalogItem } from "@bigbud/contracts";
import { ServerConfig } from "../../startup/config";
import { normalizePluginManifest, validatePluginPackage } from "../PluginManifest";
import { PluginRegistry, type PluginRegistryShape } from "../Services/PluginRegistry";
import { installedSkillRoots, resolvePluginAssetPath } from "./PluginRegistry.runtime";
import {
  emptyPluginSync,
  isContainedPath,
  marketplaceEntries,
  pluginFailureCategory,
  retainInstalledPluginMetadata,
  runGit,
  safeJson,
  type StoredPluginRegistry,
  type StoredPluginSnapshot,
} from "./PluginRegistry.utils";
const MARKETPLACE_REPOSITORY = "https://github.com/openai/plugins.git",
  CATALOG_PATH = ".agents/plugins/api_marketplace.json";
export const PluginRegistryLive = Layer.effect(
  PluginRegistry,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const root = config.pluginsDir ?? join(config.stateDir, "plugins");
    const snapshots = join(root, "snapshots");
    const packages = join(root, "packages");
    const staging = join(root, "staging");
    const snapshotFile = join(root, "catalog.json");
    const registryFile = join(root, "registry.json");
    yield* Effect.promise(() =>
      Promise.all([
        mkdir(snapshots, { recursive: true }),
        mkdir(packages, { recursive: true }),
        mkdir(staging, { recursive: true }),
      ]),
    );
    const storedSnapshot = yield* Effect.promise(() =>
      safeJson<StoredPluginSnapshot | undefined>(snapshotFile, undefined),
    );
    const storedRegistry = yield* Effect.promise(() =>
      safeJson<StoredPluginRegistry>(registryFile, { installations: [] }),
    );
    const state = yield* Ref.make({
      snapshot: storedSnapshot,
      registry: storedRegistry,
      sync: storedSnapshot
        ? ({
            status: "stale",
            commit: storedSnapshot.commit,
            successfulSyncAt: storedSnapshot.syncedAt,
          } as const)
        : emptyPluginSync("unavailable"),
    });
    const changes = yield* Effect.acquireRelease(
      PubSub.unbounded<PluginCatalog>(),
      PubSub.shutdown,
    );
    let mutationPromise: Promise<void> = Promise.resolve();
    let refreshPromise: Promise<PluginCatalog> | undefined;

    const catalog = () =>
      Ref.get(state).pipe(
        Effect.map(
          ({ snapshot, registry, sync }) =>
            ({
              revision: snapshot?.commit ?? "unavailable",
              sync,
              items: snapshot?.items ?? [],
              installed: registry.installations.map(
                ({ item: _item, ...installation }) => installation,
              ),
            }) satisfies PluginCatalog,
        ),
      );
    const persist = (next: {
      readonly snapshot?: StoredPluginSnapshot;
      readonly registry?: StoredPluginRegistry;
    }) =>
      Effect.promise(async () => {
        if (next.snapshot) {
          const temporary = `${snapshotFile}.${crypto.randomUUID()}.tmp`;
          await writeFile(temporary, JSON.stringify(next.snapshot), "utf8");
          await rename(temporary, snapshotFile);
        }
        if (next.registry) {
          const temporary = `${registryFile}.${crypto.randomUUID()}.tmp`;
          await writeFile(temporary, JSON.stringify(next.registry), "utf8");
          await rename(temporary, registryFile);
        }
      });
    const publish = () =>
      catalog().pipe(
        Effect.tap((next) => PubSub.publish(changes, next)),
        Effect.asVoid,
      );
    const refresh = () => {
      if (!refreshPromise) {
        // @effect-diagnostics-next-line runEffectInsideEffect:off
        refreshPromise = Effect.runPromise(
          Effect.gen(function* () {
            const attemptedAt = new Date().toISOString();
            const stagingRoot = join(staging, crypto.randomUUID());
            return yield* Effect.gen(function* () {
              yield* Effect.promise(() =>
                runGit([
                  "clone",
                  "--depth",
                  "1",
                  "--filter=blob:none",
                  "--sparse",
                  MARKETPLACE_REPOSITORY,
                  stagingRoot,
                ]),
              );
              yield* Effect.promise(() =>
                runGit(
                  ["sparse-checkout", "set", "--no-cone", `/${CATALOG_PATH}`, "/plugins/"],
                  stagingRoot,
                ),
              );
              const commit = yield* Effect.promise(() =>
                runGit(["rev-parse", "HEAD"], stagingRoot),
              );
              const rawCatalog = yield* Effect.promise(() =>
                readFile(join(stagingRoot, CATALOG_PATH), "utf8").then(JSON.parse),
              );
              const entries = marketplaceEntries(rawCatalog).slice(0, 500);
              const items: PluginCatalogItem[] = [];
              for (const entry of entries) {
                const name = typeof entry.name === "string" ? entry.name : undefined;
                const source = entry.source as Record<string, unknown> | undefined;
                const sourcePath =
                  source && typeof source.path === "string" ? source.path : undefined;
                if (!name || !sourcePath) continue;
                const packageRoot = resolve(stagingRoot, sourcePath);
                if (!isContainedPath(stagingRoot, packageRoot)) continue;
                const manifest = yield* Effect.promise(() =>
                  safeJson(join(packageRoot, ".codex-plugin", "plugin.json"), null),
                );
                const normalized = normalizePluginManifest({
                  marketplaceName: name,
                  commit,
                  category: typeof entry.category === "string" ? entry.category : undefined,
                  sourcePath,
                  manifest,
                } as never);
                if ("reason" in normalized) continue;
                // @effect-diagnostics-next-line tryCatchInEffectGen:off
                try {
                  yield* Effect.promise(() => validatePluginPackage(packageRoot, normalized));
                } catch {
                  continue;
                }
                items.push(normalized);
              }
              const immutableRoot = join(snapshots, commit);
              const exists = yield* Effect.promise(() =>
                lstat(immutableRoot).then(
                  () => true,
                  () => false,
                ),
              );
              if (exists)
                yield* Effect.promise(() => rm(stagingRoot, { recursive: true, force: true }));
              else yield* Effect.promise(() => rename(stagingRoot, immutableRoot));
              const snapshot = { commit, items, syncedAt: new Date().toISOString() };
              yield* persist({ snapshot });
              yield* Ref.update(state, (previous) => ({
                ...previous,
                snapshot,
                sync: {
                  status: "fresh" as const,
                  commit,
                  successfulSyncAt: snapshot.syncedAt,
                  lastAttemptedAt: attemptedAt,
                },
              }));
              yield* publish();
              return yield* catalog();
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  yield* Effect.promise(() =>
                    rm(stagingRoot, { recursive: true, force: true }),
                  ).pipe(Effect.ignoreCause({ log: false }));
                  yield* Ref.update(state, (previous) => ({
                    ...previous,
                    sync: {
                      ...(previous.snapshot
                        ? {
                            status: "stale" as const,
                            commit: previous.snapshot.commit,
                            successfulSyncAt: previous.snapshot.syncedAt,
                          }
                        : emptyPluginSync("unavailable")),
                      lastAttemptedAt: attemptedAt,
                      failure: pluginFailureCategory(Cause.squash(cause)),
                    },
                  }));
                  yield* publish();
                  return yield* catalog();
                }),
              ),
            );
          }),
        ).finally(() => {
          refreshPromise = undefined;
        });
      }
      return Effect.tryPromise({
        try: () => refreshPromise!,
        catch: () => new PluginError({ code: "unavailable", message: "Plugin refresh failed" }),
      });
    };

    const mutate = (operation: (current: PluginCatalog) => Promise<StoredPluginRegistry>) =>
      Effect.tryPromise({
        try: () => {
          const operationPromise = mutationPromise.then(async () => {
            // @effect-diagnostics-next-line runEffectInsideEffect:off
            const current = await Effect.runPromise(catalog());
            const registry = await operation(current);
            // @effect-diagnostics-next-line runEffectInsideEffect:off
            const prior = await Effect.runPromise(Ref.get(state));
            const registryWithRetainedMetadata = retainInstalledPluginMetadata(
              registry,
              prior.registry,
            );
            // @effect-diagnostics-next-line runEffectInsideEffect:off
            await Effect.runPromise(persist({ registry: registryWithRetainedMetadata }));
            // @effect-diagnostics-next-line runEffectInsideEffect:off
            await Effect.runPromise(
              Ref.update(state, (previous) => ({
                ...previous,
                registry: registryWithRetainedMetadata,
              })),
            );
            // @effect-diagnostics-next-line runEffectInsideEffect:off
            await Effect.runPromise(publish());
          });
          mutationPromise = operationPromise.catch(() => undefined);
          return operationPromise.then(async () => {
            // @effect-diagnostics-next-line runEffectInsideEffect:off
            return await Effect.runPromise(catalog());
          });
        },
        catch: (cause) =>
          Schema.is(PluginError)(cause)
            ? cause
            : new PluginError({ code: "internal", message: "Plugin mutation failed" }),
      });
    const copyPackage = async (item: PluginCatalogItem, revision: string) => {
      const source = resolve(snapshots, revision, item.sourcePath);
      const pluginId = item.id;
      const destination = join(packages, pluginId.replace(":", "--"), revision);
      await mkdir(join(packages, pluginId.replace(":", "--")), { recursive: true });
      if (!isContainedPath(join(snapshots, revision), source))
        throw new Error("Invalid plugin source");
      await validatePluginPackage(source, item);
      if (
        await lstat(destination).then(
          () => true,
          () => false,
        )
      ) {
        await validatePluginPackage(destination, item);
        return;
      }
      const stagingDestination = `${destination}.${crypto.randomUUID()}.tmp`;
      try {
        await cp(source, stagingDestination, {
          recursive: true,
          errorOnExist: true,
          verbatimSymlinks: true,
        });
        await validatePluginPackage(stagingDestination, item);
        await rename(stagingDestination, destination);
      } catch (error) {
        await rm(stagingDestination, { recursive: true, force: true });
        throw error;
      }
    };
    const service = {
      listCatalog: catalog(),
      get: (pluginId: string) =>
        Effect.gen(function* () {
          const [current, stored] = yield* Effect.all([catalog(), Ref.get(state)]);
          const item =
            current.items.find((candidate) => candidate.id === pluginId) ??
            stored.registry.installations.find((entry) => entry.pluginId === pluginId)?.item;
          if (!item)
            return yield* new PluginError({ code: "not-found", message: "Plugin not found" });
          return {
            item,
            installation: current.installed.find((entry) => entry.pluginId === pluginId),
          };
        }),
      refresh: refresh(),
      install: ({ pluginId, revision }: { pluginId: string; revision: string }) =>
        mutate(async (current) => {
          const item = current.items.find(
            (candidate) => candidate.id === pluginId && candidate.commit === revision,
          );
          if (!item) throw new Error("Stale catalog");
          if (current.installed.some((entry) => entry.pluginId === pluginId))
            return { installations: current.installed };
          await copyPackage(item, revision);
          return {
            installations: [
              ...current.installed,
              {
                pluginId: item.id,
                revision,
                ...(item.version ? { version: item.version } : {}),
                installedAt: new Date().toISOString(),
                item,
              },
            ],
          };
        }),
      update: ({
        pluginId,
        revision,
        targetRevision,
      }: {
        pluginId: string;
        revision: string;
        targetRevision: string;
      }) =>
        mutate(async (current) => {
          const installed = current.installed.find((entry) => entry.pluginId === pluginId);
          const item = current.items.find(
            (candidate) => candidate.id === pluginId && candidate.commit === targetRevision,
          );
          if (!installed || installed.revision !== revision || !item)
            throw new Error("Stale plugin update");
          await copyPackage(item, targetRevision);
          return {
            installations: current.installed.map((entry) =>
              entry.pluginId === pluginId
                ? {
                    pluginId: entry.pluginId,
                    revision: targetRevision,
                    ...(item.version ? { version: item.version } : {}),
                    installedAt: entry.installedAt,
                    item,
                  }
                : entry,
            ),
          };
        }),
      uninstall: ({ pluginId, revision }: { pluginId: string; revision: string }) =>
        mutate(async (current) => {
          const installed = current.installed.find((entry) => entry.pluginId === pluginId);
          if (!installed || installed.revision !== revision)
            throw new Error("Stale plugin uninstall");
          return {
            installations: current.installed.filter((entry) => entry.pluginId !== pluginId),
          };
        }),
      streamChanges: Stream.fromPubSub(changes),
      resolveAsset: ({
        scope,
        revision,
        pluginId,
        assetKey,
      }: {
        scope: "catalog" | "installed";
        revision: string;
        pluginId: string;
        assetKey: "composerIcon" | "logo" | "logoDark";
      }) =>
        Ref.get(state).pipe(
          Effect.map(({ snapshot, registry }) =>
            resolvePluginAssetPath({
              snapshots,
              packages,
              snapshot,
              registry,
              scope,
              revision,
              pluginId,
              assetKey,
            }),
          ),
        ),
      getInstalledSkillRoots: Ref.get(state).pipe(
        Effect.map(({ snapshot, registry }) =>
          installedSkillRoots({ packages, snapshot, registry }),
        ),
      ),
    } as unknown as PluginRegistryShape;
    yield* refresh().pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);
    return service;
  }),
);
