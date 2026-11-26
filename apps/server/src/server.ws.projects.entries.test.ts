import { WS_METHODS } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Path } from "effect";

import {
  buildAppUnderTest,
  getWsServerUrl,
  serverTestLayer,
  withWsRpcClient,
} from "./server.test.helpers.ts";
import { serverHttpTestLayer } from "./server.test.http.ts";

it.layer(serverTestLayer)("server router seam > websocket Files create and delete", (it) => {
  it.effect("routes entry actions, create folder and refusals over websocket rpc", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-entries-" });
      yield* fs.writeFileString(path.join(workspaceDir, "README.md"), "readme");

      yield* buildAppUnderTest();
      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const actions = yield* client[WS_METHODS.projectsEntryActions]({ cwd: workspaceDir });
            const directSsh = yield* client[WS_METHODS.projectsEntryActions]({
              cwd: "/srv/project",
              executionTargetId: "ssh:host=example&transport=direct-ssh",
            });
            const created = yield* client[WS_METHODS.projectsCreateDirectory]({
              cwd: workspaceDir,
              relativePath: "docs",
            });
            const duplicate = yield* Effect.exit(
              client[WS_METHODS.projectsCreateDirectory]({
                cwd: workspaceDir,
                relativePath: "README.md",
              }),
            );
            const root = yield* Effect.exit(
              client[WS_METHODS.projectsDeleteEntry]({
                cwd: workspaceDir,
                relativePath: ".",
                expectedKind: "directory",
              }),
            );
            return { actions, directSsh, created, duplicate, root };
          }),
        ),
      );

      assert.isTrue(result.actions.createFolder.allowed);
      assert.isTrue(result.actions.delete.allowed);
      // SSH Files always run through the Rust owner, which advertises folder create; a missing
      // owner refuses at dispatch rather than hiding the action.
      assert.deepEqual(result.directSsh.createFolder, { allowed: true });
      assert.equal(result.created.relativePath, "docs");
      assert.equal((yield* fs.stat(path.join(workspaceDir, "docs"))).type, "Directory");
      assert.isTrue(Exit.isFailure(result.duplicate));
      assert.include(JSON.stringify(result.duplicate), '"alreadyExists":true');
      assert.equal(yield* fs.readFileString(path.join(workspaceDir, "README.md")), "readme");
      assert.isTrue(Exit.isFailure(result.root));
      assert.include(JSON.stringify(result.root), "not-dispatched");
      assert.isTrue(yield* fs.exists(workspaceDir));
    }).pipe(Effect.provide(serverHttpTestLayer)),
  );
});
