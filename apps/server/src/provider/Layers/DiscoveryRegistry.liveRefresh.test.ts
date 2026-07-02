import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { withRegistry, writeFile } from "./DiscoveryRegistry.test.shared";

describe("DiscoveryRegistry — provider descriptor coverage", () => {
  it.layer(NodeServices.layer)("discovers entries for every supported provider label", (it) => {
    it.effect("loads provider-tagged discovery entries from provider-specific roots", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-provider-coverage-" });

        yield* writeFile(
          path.join(cwd, ".codex/agents/codex-agent.toml"),
          'name = "codex-agent"\ndescription = "Codex agent"\n',
        );
        yield* writeFile(
          path.join(cwd, ".claude/agents/claude-agent.md"),
          "---\nname: claude-agent\ndescription: Claude agent\n---\n",
        );
        yield* writeFile(
          path.join(cwd, ".github/agents/copilot-agent.md"),
          "---\nname: copilot-agent\ndescription: Copilot agent\n---\n",
        );
        yield* writeFile(
          path.join(cwd, ".cursor/skills/cursor-skill/SKILL.md"),
          "---\nname: cursor-skill\ndescription: Cursor skill\n---\n",
        );
        yield* writeFile(
          path.join(cwd, ".opencode/skills/opencode-skill/SKILL.md"),
          "---\nname: opencode-skill\ndescription: OpenCode skill\n---\n",
        );
        yield* writeFile(
          path.join(cwd, ".pi/skills/pi-skill/SKILL.md"),
          "---\nname: pi-skill\ndescription: Pi skill\n---\n",
        );
        yield* writeFile(
          path.join(cwd, ".devin/skills/devin-skill/SKILL.md"),
          "---\nname: devin-skill\ndescription: Devin skill\n---\n",
        );
        yield* writeFile(
          path.join(cwd, ".kilocode/skills/kilocode-skill/SKILL.md"),
          "---\nname: kilocode-skill\ndescription: Kilocode skill\n---\n",
        );
        yield* writeFile(
          path.join(cwd, ".bigbud/skills/bigbud-skill/SKILL.md"),
          "---\nname: bigbud-skill\ndescription: bigbud skill\n---\n",
        );

        const catalog = yield* withRegistry(cwd, (registry) => registry.getCatalog);
        const providers = new Set([
          ...catalog.agents.map((entry) => entry.provider),
          ...catalog.skills.map((entry) => entry.provider),
        ]);

        assert.isTrue(providers.has("codex"));
        assert.isTrue(providers.has("claudeAgent"));
        assert.isTrue(providers.has("copilot"));
        assert.isTrue(providers.has("cursor"));
        assert.isTrue(providers.has("opencode"));
        assert.isTrue(providers.has("pi"));
        assert.isTrue(providers.has("devin"));
        assert.isTrue(providers.has("kilocode"));
        assert.isTrue(providers.has("bigbud"));
      }),
    );
  });
});
