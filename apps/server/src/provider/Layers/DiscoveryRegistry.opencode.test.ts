import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { getCatalog, writeFile } from "./DiscoveryRegistry.test.shared";

describe("DiscoveryRegistry — opencode config agents", () => {
  it.layer(NodeServices.layer)("parses opencode config JSON agent blocks", (it) => {
    it.effect("discovers agents defined in .opencode/opencode.json", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-test-" });

        yield* writeFile(
          path.join(cwd, ".opencode/opencode.json"),
          `agent = {\n  name = "My Reviewer"\n  description = "Reviews code"\n}\n`,
        );

        const catalog = yield* getCatalog(cwd);

        const agent = catalog.agents.find(
          (entry) => entry.provider === "opencode" && entry.name === "My Reviewer",
        );
        assert.isDefined(agent, "should discover opencode config agent");
        assert.strictEqual(agent?.description, "Reviews code");
        assert.strictEqual(agent?.source, "project");
      }),
    );

    it.effect("returns no project-scoped opencode agents when config does not exist", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-test-" });

        const catalog = yield* getCatalog(cwd);
        const projectOpencode = catalog.agents.filter(
          (entry) => entry.provider === "opencode" && entry.source === "project",
        );

        assert.strictEqual(projectOpencode.length, 0);
      }),
    );

    it.effect("discovers agents from JSON-format opencode.json", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-test-" });

        yield* writeFile(
          path.join(cwd, ".opencode/opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            agent: {
              "my-reviewer": {
                description: "Reviews code changes",
                mode: "subagent",
              },
              "security-engineer": {
                description: "Security review",
                mode: "subagent",
                tools: { write: true, edit: false },
              },
            },
          }),
        );

        const catalog = yield* getCatalog(cwd);

        const reviewer = catalog.agents.find(
          (entry) => entry.provider === "opencode" && entry.name === "my-reviewer",
        );
        assert.isDefined(reviewer, "should discover my-reviewer agent from JSON config");
        assert.strictEqual(reviewer?.description, "Reviews code changes");
        assert.strictEqual(reviewer?.source, "project");

        const security = catalog.agents.find(
          (entry) => entry.provider === "opencode" && entry.name === "security-engineer",
        );
        assert.isDefined(security, "should discover security-engineer agent with nested tools");
        assert.strictEqual(security?.description, "Security review");
      }),
    );

    it.effect("discovers packaged bundled opencode agents from BIGBUD_BUNDLED_AGENTS_DIR", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "disc-test-" });
        const bundledAgentsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "disc-bundled-agents-",
        });
        const previousBundledAgentsDir = process.env.BIGBUD_BUNDLED_AGENTS_DIR;

        try {
          process.env.BIGBUD_BUNDLED_AGENTS_DIR = bundledAgentsDir;
          yield* writeFile(
            path.join(bundledAgentsDir, "packaged-reviewer.md"),
            [
              "---",
              "description: Review packaged builds",
              "mode: subagent",
              "---",
              "",
              "Debug issues step by step.",
            ].join("\n"),
          );

          const catalog = yield* getCatalog(cwd);

          const agent = catalog.agents.find(
            (entry) => entry.provider === "opencode" && entry.name === "packaged-reviewer",
          );
          assert.isDefined(agent, "packaged bundled opencode agent should be discovered");
          assert.strictEqual(agent?.description, "Review packaged builds");
          assert.strictEqual(agent?.source, "system");
          assert.strictEqual(
            agent?.sourcePath,
            path.join(bundledAgentsDir, "packaged-reviewer.md"),
          );
        } finally {
          if (previousBundledAgentsDir === undefined) {
            delete process.env.BIGBUD_BUNDLED_AGENTS_DIR;
          } else {
            process.env.BIGBUD_BUNDLED_AGENTS_DIR = previousBundledAgentsDir;
          }
        }
      }),
    );
  });
});
