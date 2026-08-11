import { describe, expect, it } from "vitest";
import type { PluginCatalog } from "@bigbud/contracts";

import { getPluginUpdateNames } from "./PluginUpdateToastCoordinator";

describe("getPluginUpdateNames", () => {
  it("returns only installed plugins with a newer catalog revision", () => {
    const item = {
      id: "openai-public:remotion",
      name: "remotion",
      commit: "new",
      sourcePath: "plugins/remotion",
      presentation: { displayName: "Remotion", assets: {} },
      components: [{ kind: "skill", name: "remotion", path: "skills" }],
      compatibility: "compatible",
    } as const;
    const catalog = {
      revision: "new",
      sync: { status: "fresh" },
      items: [item],
      installed: [{ pluginId: item.id, revision: "old", installedAt: "2026-08-09T00:00:00Z" }],
    } satisfies PluginCatalog;

    expect(getPluginUpdateNames(catalog)).toEqual(["Remotion"]);
  });
});
