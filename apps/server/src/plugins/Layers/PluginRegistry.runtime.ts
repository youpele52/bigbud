import { join, resolve } from "node:path";
import type { PluginAssetKey } from "@bigbud/contracts";

import {
  isContainedPath,
  type StoredPluginRegistry,
  type StoredPluginSnapshot,
} from "./PluginRegistry.utils";

export function resolvePluginAssetPath(input: {
  readonly snapshots: string;
  readonly packages: string;
  readonly snapshot: StoredPluginSnapshot | undefined;
  readonly registry: StoredPluginRegistry;
  readonly scope: "catalog" | "installed";
  readonly revision: string;
  readonly pluginId: string;
  readonly assetKey: PluginAssetKey;
}): string | undefined {
  const item =
    input.scope === "catalog"
      ? input.snapshot?.items.find(
          (candidate) => candidate.id === input.pluginId && candidate.commit === input.revision,
        )
      : input.registry.installations.find(
          (installation) =>
            installation.pluginId === input.pluginId && installation.revision === input.revision,
        )?.item;
  const asset = item?.presentation.assets[input.assetKey];
  if (!item || !asset || !/\.(png|jpe?g|webp|svg)$/iu.test(asset)) return undefined;
  const root =
    input.scope === "catalog"
      ? resolve(input.snapshots, input.revision, item.sourcePath)
      : join(input.packages, input.pluginId.replace(":", "--"), input.revision);
  const candidate = resolve(root, asset);
  const revisionRoot = join(input.snapshots, input.revision);
  if (input.scope === "catalog" && !isContainedPath(revisionRoot, root)) return undefined;
  return isContainedPath(root, candidate) ? candidate : undefined;
}

export function installedSkillRoots(input: {
  readonly packages: string;
  readonly snapshot: StoredPluginSnapshot | undefined;
  readonly registry: StoredPluginRegistry;
}) {
  return input.registry.installations.flatMap((installation) => {
    const item =
      installation.item ??
      input.snapshot?.items.find(
        (candidate) =>
          candidate.id === installation.pluginId && candidate.commit === installation.revision,
      );
    return item
      ? item.components.map((component) => ({
          pluginId: item.id,
          revision: installation.revision,
          root: join(
            input.packages,
            item.id.replace(":", "--"),
            installation.revision,
            component.path,
          ),
        }))
      : [];
  });
}
