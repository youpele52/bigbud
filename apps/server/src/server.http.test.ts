import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { HttpClient } from "effect/unstable/http";

import { resolveAttachmentRelativePath } from "./attachments/attachmentPaths.ts";
import { buildAppUnderTest, getHttpServerUrl, serverTestLayer } from "./server.test.helpers.ts";

it.layer(serverTestLayer)("server router seam > http", (it) => {
  it.effect("serves static index content for GET / when staticDir is configured", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-static-" });
      const indexPath = path.join(staticDir, "index.html");
      yield* fileSystem.writeFileString(indexPath, "<html>router-static-ok</html>");

      yield* buildAppUnderTest({ config: { staticDir } });

      const response = yield* HttpClient.get("/");
      assert.equal(response.status, 200);
      assert.include(yield* response.text, "router-static-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("redirects to dev URL when configured", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173") },
      });

      const url = yield* getHttpServerUrl("/foo/bar");
      const response = yield* Effect.promise(() => fetch(url, { redirect: "manual" }));

      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), "http://127.0.0.1:5173/");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves project favicon requests before the dev URL redirect", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-router-project-favicon-",
      });
      yield* fileSystem.writeFileString(
        path.join(projectDir, "favicon.svg"),
        "<svg>router-project-favicon</svg>",
      );

      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173") },
      });

      const response = yield* HttpClient.get(
        `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`,
      );

      assert.equal(response.status, 200);
      assert.equal(yield* response.text, "<svg>router-project-favicon</svg>");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves the fallback project favicon when no icon exists", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const projectDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-router-project-favicon-fallback-",
      });

      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173") },
      });

      const response = yield* HttpClient.get(
        `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`,
      );

      assert.equal(response.status, 200);
      assert.include(yield* response.text, 'data-fallback="project-favicon"');
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves attachment files from state dir", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-11111111-1111-4111-8111-111111111111";

      const config = yield* buildAppUnderTest();
      const attachmentPath = resolveAttachmentRelativePath({
        attachmentsDir: config.attachmentsDir,
        relativePath: `${attachmentId}.bin`,
      });
      assert.isNotNull(attachmentPath, "Attachment path should be resolvable");

      yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true });
      yield* fileSystem.writeFileString(attachmentPath, "attachment-ok");

      const response = yield* HttpClient.get(`/attachments/${attachmentId}`);
      assert.equal(response.status, 200);
      assert.equal(yield* response.text, "attachment-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves attachment files for URL-encoded paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const config = yield* buildAppUnderTest();
      const attachmentPath = resolveAttachmentRelativePath({
        attachmentsDir: config.attachmentsDir,
        relativePath: "thread%20folder/message%20folder/file%20name.png",
      });
      assert.isNotNull(attachmentPath, "Attachment path should be resolvable");

      yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true });
      yield* fileSystem.writeFileString(attachmentPath, "attachment-encoded-ok");

      const response = yield* HttpClient.get(
        "/attachments/thread%20folder/message%20folder/file%20name.png",
      );
      assert.equal(response.status, 200);
      assert.equal(yield* response.text, "attachment-encoded-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns 404 for missing attachment id lookups", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.get(
        "/attachments/missing-11111111-1111-4111-8111-111111111111",
      );
      assert.equal(response.status, 404);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
