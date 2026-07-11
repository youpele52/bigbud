import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../startup/config.ts";
import { MemoryStore } from "../Services/MemoryStore.ts";
import { MemoryStoreLive } from "./MemoryStore.ts";

const layer = MemoryStoreLive.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-memory-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("MemoryStore", (it) => {
  it.effect("writes user and project documents in separate scopes", () =>
    Effect.gen(function* () {
      const store = yield* MemoryStore;
      const projectId = ProjectId.makeUnsafe("project-memory-test");

      yield* store.write({ scope: "user", projectId: null, content: "User preference\n" });
      yield* store.write({ scope: "project", projectId, content: "Project fact\n" });

      const user = yield* store.read({ scope: "user", projectId: null });
      const project = yield* store.read({ scope: "project", projectId });
      assert.equal(user.content, "User preference\n");
      assert.equal(project.content, "Project fact\n");
    }),
  );

  it.effect("rejects a stale compare-before-write", () =>
    Effect.gen(function* () {
      const store = yield* MemoryStore;
      yield* store.write({ scope: "global", projectId: null, content: "Current\n" });
      const error = yield* Effect.flip(
        store.write({
          scope: "global",
          projectId: null,
          content: "Replacement\n",
          expectedContent: "Stale\n",
        }),
      );
      assert.equal(error._tag, "MemoryConflictError");
    }),
  );
});
