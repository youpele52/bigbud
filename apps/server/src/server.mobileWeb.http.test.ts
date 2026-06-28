import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { HttpClient } from "effect/unstable/http";

import { buildAppUnderTest, serverTestLayer } from "./server.test.helpers.ts";

it.layer(serverTestLayer)("server router seam > mobile web static", (it) => {
  it.effect("serves the mobile companion shell from /mobile", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const mobileWebStaticDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-router-mobile-web-",
      });
      yield* fileSystem.writeFileString(
        path.join(mobileWebStaticDir, "index.html"),
        '<html><script src="/mobile/assets/app.js"></script>mobile-shell-ok</html>',
      );

      yield* buildAppUnderTest({ config: { mobileWebStaticDir } });

      const response = yield* HttpClient.get("/mobile/pair/pairing-1");
      assert.equal(response.status, 200);
      assert.include(yield* response.text, "mobile-shell-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
