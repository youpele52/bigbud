import { assert, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Option } from "effect";

import { NetService } from "@bigbud/shared/Net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { resolveServerConfig } from "./cli";

it.layer(NodeServices.layer)("desktop bootstrap envelope lifecycle fields", (it) => {
  const resolveWithEnvelope = Effect.fn(function* (extra: Record<string, unknown>) {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "bigbud-envelope-home-" });
    const filePath = yield* fs.makeTempFileScoped({
      prefix: "bigbud-bootstrap-",
      suffix: ".ndjson",
    });
    const envelope = { mode: "desktop", port: 4888, t3Home: baseDir, noBrowser: true, ...extra };
    yield* fs.writeFileString(filePath, `${JSON.stringify(envelope)}\n`);
    const { fd } = yield* fs.open(filePath, { flag: "r" });
    return yield* resolveServerConfig(
      {
        mode: Option.none(),
        port: Option.none(),
        host: Option.none(),
        baseDir: Option.none(),
        cwd: Option.none(),
        devUrl: Option.none(),
        noBrowser: Option.none(),
        authToken: Option.none(),
        bootstrapFd: Option.none(),
        autoBootstrapProjectFromCwd: Option.none(),
        logWebSocketEvents: Option.none(),
      },
      Option.none(),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { BIGBUD_BOOTSTRAP_FD: String(fd) } }),
          ),
          NetService.layer,
        ),
      ),
    );
  });

  it.effect("reads the hint pipe only when the envelope announces it", () =>
    Effect.gen(function* () {
      const announced = yield* resolveWithEnvelope({ lifecycleHintFd: 5 });
      assert.strictEqual(announced.mode, "desktop");
      assert.strictEqual(announced.desktopLifecycleHintFd, 5);
      const silent = yield* resolveWithEnvelope({});
      assert.strictEqual(silent.mode, "desktop");
      assert.isUndefined(silent.desktopLifecycleHintFd);
    }),
  );

  it.effect("decodes the start reason with and without the hint pipe", () =>
    Effect.gen(function* () {
      const restarted = yield* resolveWithEnvelope({
        startReason: "resume-probe-restart",
        lifecycleHintFd: 5,
      });
      assert.strictEqual(restarted.desktopStartReason, "resume-probe-restart");
      assert.strictEqual(restarted.desktopLifecycleHintFd, 5);
      const ordinary = yield* resolveWithEnvelope({ lifecycleHintFd: 5 });
      assert.isUndefined(ordinary.desktopStartReason);
      const oldDesktop = yield* resolveWithEnvelope({ startReason: "resume-probe-restart" });
      assert.strictEqual(oldDesktop.desktopStartReason, "resume-probe-restart");
      assert.isUndefined(oldDesktop.desktopLifecycleHintFd);
    }),
  );
});
