import { describe, expect, it } from "vitest";

import { normalizePluginManifest } from "./PluginManifest";

describe("normalizePluginManifest", () => {
  it("accepts the Codex-compatible single skills directory form", () => {
    const result = normalizePluginManifest({
      marketplaceName: "remotion",
      commit: "abc123",
      sourcePath: "plugins/remotion",
      manifest: {
        name: "remotion",
        skills: "./skills",
        interface: {
          displayName: "Remotion",
          composerIcon: "./assets/icon.png",
        },
      },
    });

    expect(result).toMatchObject({
      id: "openai-public:remotion",
      sourcePath: "plugins/remotion",
      components: [{ kind: "skill", path: "./skills" }],
    });
  });

  it("rejects unsupported executable components", () => {
    const result = normalizePluginManifest({
      marketplaceName: "unsafe",
      commit: "abc123",
      sourcePath: "plugins/unsafe",
      manifest: {
        name: "unsafe",
        skills: "./skills",
        hooks: "./hooks/hooks.json",
      },
    });

    expect(result).toEqual({
      reason: "unsupported component: hooks",
      unsupported: true,
    });
  });
});
