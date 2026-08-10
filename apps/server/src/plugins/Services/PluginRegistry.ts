import type { PluginCatalog, PluginCatalogItem, PluginInstallation } from "@bigbud/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

export interface PluginRegistryShape {
  readonly listCatalog: Effect.Effect<PluginCatalog>;
  readonly get: (pluginId: string) => Effect.Effect<{
    readonly item: PluginCatalogItem;
    readonly installation: PluginInstallation | undefined;
  }>;
  readonly refresh: Effect.Effect<PluginCatalog>;
  readonly install: (input: { pluginId: string; revision: string }) => Effect.Effect<PluginCatalog>;
  readonly update: (input: {
    pluginId: string;
    revision: string;
    targetRevision: string;
  }) => Effect.Effect<PluginCatalog>;
  readonly uninstall: (input: {
    pluginId: string;
    revision: string;
  }) => Effect.Effect<PluginCatalog>;
  readonly streamChanges: Stream.Stream<PluginCatalog>;
  readonly resolveAsset: (input: {
    scope: "catalog" | "installed";
    revision: string;
    pluginId: string;
    assetKey: "composerIcon" | "logo" | "logoDark";
  }) => Effect.Effect<string | undefined>;
  readonly getInstalledSkillRoots: Effect.Effect<
    ReadonlyArray<{
      pluginId: string;
      revision: string;
      root: string;
    }>
  >;
}

export class PluginRegistry extends ServiceMap.Service<PluginRegistry, PluginRegistryShape>()(
  "bigbud/plugins/PluginRegistry",
) {}
