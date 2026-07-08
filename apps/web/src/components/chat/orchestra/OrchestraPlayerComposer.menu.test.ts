import { describe, expect, it } from "vitest";

import {
  extendReplacementRangeForTrailingSpace,
  filterUnsupportedSlashCommands,
  resolveDiscoverySearch,
} from "./OrchestraPlayerComposer.menu";

describe("OrchestraPlayerComposer.menu", () => {
  it("filters chat-only slash commands from orchestra composer menus", () => {
    const items = filterUnsupportedSlashCommands([
      {
        id: "slash:plan",
        type: "slash-command",
        command: "plan",
        label: "/plan",
        description: "Switch this thread into plan mode",
      },
      {
        id: "slash:agents",
        type: "slash-command",
        command: "agents",
        label: "/agents",
        description: "Browse discovered agents",
      },
      {
        id: "provider-slash:opencode:doctor",
        type: "slash-command",
        command: "doctor",
        label: "/doctor",
        description: "Check local setup",
      },
    ]);

    expect(items.map((item) => item.id)).toEqual([
      "slash:agents",
      "provider-slash:opencode:doctor",
    ]);
  });

  it("extends replacements over one existing trailing space", () => {
    expect(
      extendReplacementRangeForTrailingSpace("@agent ", "@agent".length, "@agent::code "),
    ).toBe("@agent ".length);
    expect(extendReplacementRangeForTrailingSpace("@agent", "@agent".length, "@agent::code ")).toBe(
      "@agent".length,
    );
    expect(extendReplacementRangeForTrailingSpace("@agent ", "@agent".length, "@agent::code")).toBe(
      "@agent".length,
    );
  });

  it("resolves slash skill discovery search updates", () => {
    const replacements: string[] = [];
    const discoverySearch = resolveDiscoverySearch({
      syntheticMenuKind: null,
      syntheticMenuSearch: "",
      trigger: {
        kind: "slash-command",
        query: "skills hand",
        rangeStart: 0,
        rangeEnd: "/skills hand".length,
      },
      applyPromptReplacement: (_rangeStart, _rangeEnd, replacement) => {
        replacements.push(replacement);
        return true;
      },
      onResetHighlight: () => undefined,
    });

    expect(discoverySearch).toMatchObject({
      command: "skills",
      query: "hand",
    });

    discoverySearch?.onQueryChange("review");

    expect(replacements).toEqual(["/skills review"]);
  });
});
