import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { NetService } from "@bigbud/shared/Net";
import { ConfigProvider, Effect, FileSystem, Layer, Option, Path } from "effect";
import { resolveServerConfig, type CliServerFlags } from "./cli.config.ts";

it.layer(NodeServices.layer)("terminal shell startup evidence", (it) => {
  for (const dev of [false, true]) {
    it.effect(`captures evidence before cwd mkdir (${dev ? "dev" : "userdata"})`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "bigbud-shell-cli-" });
        const stateDir = path.join(baseDir, dev ? "dev" : "userdata");
        const flags: CliServerFlags = {
          mode: Option.some("web"),
          port: Option.some(4888),
          host: Option.none(),
          baseDir: Option.none(),
          cwd: Option.some(path.join(stateDir, "project")),
          devUrl: dev ? Option.some(new URL("http://localhost:5173")) : Option.none(),
          noBrowser: Option.none(),
          authToken: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
        };
        const resolve = (env: Record<string, string>) =>
          resolveServerConfig(flags, Option.none()).pipe(
            Effect.provide(
              Layer.mergeAll(
                ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
                NetService.layer,
              ),
            ),
          );
        const first = yield* resolve({
          BIGBUD_HOME: baseDir,
          T3CODE_HOME: path.join(baseDir, "unused"),
        });
        expect(first.stateDir).toBe(stateDir);
        expect(first.terminalShellInstallEvidence).toBe("fresh");
        expect(yield* fs.exists(path.join(baseDir, "unused"))).toBe(false);
        const second = yield* resolve({ T3CODE_HOME: baseDir });
        expect(second.stateDir).toBe(stateDir);
        expect(second.terminalShellInstallEvidence).toBe("existing-or-uncertain");
        expect(yield* fs.exists(first.settingsPath)).toBe(false);
      }),
    );
  }
});
