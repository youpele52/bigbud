import { describe, expect, it } from "vitest";
import type { PluginCatalogItem } from "@bigbud/contracts";

import { PLUGIN_CATEGORY_GRID_CLASS } from "./PluginStorePage";
import { groupPluginsByCategory, matchesPlugin } from "./PluginStorePage.logic";
import { STANDALONE_PAGE_SCROLL_CLASS } from "../standalone/StandalonePageContent";

const plugin = {
  id: "openai-public:example",
  name: "example",
  commit: "revision-1",
  sourcePath: "plugins/example",
  presentation: {
    displayName: "Example Plugin",
    shortDescription: "A concise automation helper",
    developer: "Example Labs",
    category: "Productivity",
    assets: {},
  },
  components: [{ kind: "skill", name: "example", path: "skills" }],
  compatibility: "compatible",
} satisfies PluginCatalogItem;

describe("matchesPlugin", () => {
  it.each(["Example Plugin", "automation", "Example Labs", "Productivity"])(
    "filters by %s",
    (query) => {
      expect(matchesPlugin(plugin, query)).toBe(true);
    },
  );
});

describe("PluginStorePage layout", () => {
  it("keeps scroll ownership and responsive one and two-column category grids", () => {
    expect(STANDALONE_PAGE_SCROLL_CLASS).toContain("min-h-0");
    expect(STANDALONE_PAGE_SCROLL_CLASS).toContain("overflow-y-auto");
    expect(PLUGIN_CATEGORY_GRID_CLASS).toContain("grid-cols-1");
    expect(PLUGIN_CATEGORY_GRID_CLASS).toContain("md:grid-cols-2");
    expect(PLUGIN_CATEGORY_GRID_CLASS).not.toContain("grid-cols-3");
    expect(PLUGIN_CATEGORY_GRID_CLASS).toContain("gap-x-12");
  });
});

describe("groupPluginsByCategory", () => {
  it("groups filtered marketplace items by category while preserving their order", () => {
    const other = {
      ...plugin,
      id: "openai-public:other",
      presentation: { ...plugin.presentation, category: undefined },
    };
    const second = {
      ...plugin,
      id: "openai-public:second",
      presentation: { ...plugin.presentation, category: "Developer tools" },
    };
    const result = groupPluginsByCategory(
      [plugin, other, second].filter((item) => matchesPlugin(item, "")),
    );

    expect(result.map(([category]) => category)).toEqual([
      "Productivity",
      "Developer Tools",
      "Others",
    ]);
    expect(result.map(([, items]) => items.map((item) => item.id))).toEqual([
      [plugin.id],
      [second.id],
      [other.id],
    ]);
  });

  it("uses the requested category order and puts unlisted categories in Others", () => {
    const creativity = {
      ...plugin,
      id: "openai-public:creativity",
      presentation: { ...plugin.presentation, category: "Creativity" },
    };
    const unlisted = {
      ...plugin,
      id: "openai-public:unlisted",
      presentation: { ...plugin.presentation, category: "Operations" },
    };

    expect(
      groupPluginsByCategory([plugin, unlisted, creativity]).map(([category]) => category),
    ).toEqual(["Creativity", "Productivity", "Others"]);
  });
});
