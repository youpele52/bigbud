import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { afterEach, vi } from "vitest";
import { setThreadOrchestrationToolDispatcher } from "../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import { writeThreadOrchestrationToolAuth } from "../orchestration-tools/ThreadOrchestrationToolAuth.ts";
import { buildAppUnderTest, getHttpServerUrl, serverTestLayer } from "../server.test.helpers.ts";
import { serverHttpTestLayer } from "../server.test.http.ts";
import { deriveServerPaths } from "../startup/config.ts";

afterEach(() => setThreadOrchestrationToolDispatcher(null));
it.layer(serverTestLayer)("HTML publication auth", (it) => {
  it.effect("binds publication to the token owner, never the requested thread", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "html-auth-" });
      const { stateDir } = yield* deriveServerPaths(baseDir, undefined);
      yield* Effect.promise(() =>
        writeThreadOrchestrationToolAuth({ stateDir, threadId: "owner", token: "html-token" }),
      );
      const renderHtml = vi.fn(() =>
        Effect.succeed({ artifactId: "artifact", turnId: "turn", published: true }),
      );
      setThreadOrchestrationToolDispatcher({
        renderHtml,
        rename: () => Effect.succeed({ title: "Title" }),
        archive: () => Effect.succeed({ archived: true as const }),
        getStatus: () => Effect.die("unused"),
        listPinned: () => Effect.die("unused"),
        setPinned: () => Effect.die("unused"),
        computerUse: () => Effect.die("unused"),
        browser: () => Effect.die("unused"),
      });
      yield* buildAppUnderTest({ config: { baseDir } });
      const url = yield* getHttpServerUrl("/api/internal/thread-tools");
      const body = JSON.stringify({
        action: "render_html",
        threadId: "victim",
        invocationId: "call",
        htmlArguments: { title: "Chart", html: "<p>Chart</p>" },
      });
      const denied = yield* Effect.promise(() =>
        fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body }),
      );
      assert.equal(denied.status, 401);
      assert.equal(renderHtml.mock.calls.length, 0);
      const allowed = yield* Effect.promise(() =>
        fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bigbud-thread-tool-token": "html-token",
          },
          body,
        }),
      );
      assert.equal(allowed.status, 200);
      assert.deepEqual(renderHtml.mock.calls[0], [
        {
          threadId: "owner",
          invocationId: "call",
          arguments: { title: "Chart", html: "<p>Chart</p>" },
        },
      ]);
    }).pipe(Effect.provide(serverHttpTestLayer)),
  );
});
