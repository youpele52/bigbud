import type { PluginCatalogItem } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { installedSkillRoots } from "./PluginRegistry.runtime";

function item(commit: string, path: string): PluginCatalogItem {
  return {
    id: "openai-public:example",
    name: "example",
    commit,
    sourcePath: "./plugins/example",
    presentation: { displayName: "Example", assets: {} },
    components: [{ kind: "skill", name: "example", path }],
    compatibility: "compatible",
  };
}

describe("installedSkillRoots", () => {
  it("keeps installed metadata when a newer catalog changes component paths", () => {
    const installedItem = item("revision-a", "./skills/old");
    expect(
      installedSkillRoots({
        packages: "/plugins/packages",
        snapshot: {
          commit: "revision-b",
          syncedAt: "2026-08-09T00:00:00Z",
          items: [item("revision-b", "./skills/new")],
        },
        registry: {
          installations: [
            {
              pluginId: installedItem.id,
              revision: installedItem.commit,
              installedAt: "2026-08-09T00:00:00Z",
              item: installedItem,
            },
          ],
        },
      }),
    ).toEqual([
      {
        pluginId: installedItem.id,
        revision: "revision-a",
        root: "/plugins/packages/openai-public--example/revision-a/skills/old",
      },
    ]);
  });

  it("uses legacy snapshot metadata only when its revision matches the installation", () => {
    const installation = {
      pluginId: "openai-public:example",
      revision: "revision-a",
      installedAt: "2026-08-09T00:00:00Z",
    };
    expect(
      installedSkillRoots({
        packages: "/plugins/packages",
        snapshot: {
          commit: "revision-b",
          syncedAt: "2026-08-09T00:00:00Z",
          items: [item("revision-b", "./skills/new")],
        },
        registry: { installations: [installation] },
      }),
    ).toEqual([]);
    expect(
      installedSkillRoots({
        packages: "/plugins/packages",
        snapshot: {
          commit: "revision-a",
          syncedAt: "2026-08-09T00:00:00Z",
          items: [item("revision-a", "./skills/old")],
        },
        registry: { installations: [installation] },
      }),
    ).toEqual([
      {
        pluginId: "openai-public:example",
        revision: "revision-a",
        root: "/plugins/packages/openai-public--example/revision-a/skills/old",
      },
    ]);
  });
});
