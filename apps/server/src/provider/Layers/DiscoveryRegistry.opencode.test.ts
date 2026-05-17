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
  });
});
