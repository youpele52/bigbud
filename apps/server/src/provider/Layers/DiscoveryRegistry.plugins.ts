import type { ServerDiscoveredSkill } from "@bigbud/contracts";

import type { DiscoveryFileDescriptor } from "./DiscoveryRegistry.descriptors";

export type PluginDiscoveryRoot = {
  readonly pluginId: string;
  readonly revision: string;
  readonly root: string;
};

export function buildPluginSkillDescriptors(
  roots: ReadonlyArray<PluginDiscoveryRoot>,
): ReadonlyArray<
  DiscoveryFileDescriptor & { readonly pluginId: string; readonly pluginRevision: string }
> {
  return roots.map((root) => ({
    provider: "bigbud",
    kind: "skill",
    source: "plugin",
    path: root.root,
    pluginId: root.pluginId,
    pluginRevision: root.revision,
  }));
}

export function withPluginProvenance(
  skill: ServerDiscoveredSkill,
  descriptor: {
    readonly pluginId?: string | undefined;
    readonly pluginRevision?: string | undefined;
  },
): ServerDiscoveredSkill {
  return descriptor.pluginId
    ? {
        ...skill,
        pluginId: descriptor.pluginId,
        ...(descriptor.pluginRevision ? { pluginRevision: descriptor.pluginRevision } : {}),
        id: `bigbud:plugin:${descriptor.pluginId}:${skill.name}:${skill.sourcePath ?? skill.id}`,
      }
    : skill;
}
