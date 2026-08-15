import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { FileSystem, Path, Effect } from "effect";

import { resolveAvailableTerminals, resolveTerminalLaunch } from "./open";

const CLI_ONLY_ENV = { PATH: "" } satisfies NodeJS.ProcessEnv;

it.layer(NodeServices.layer)("terminal launchers", (it) => {
  it.effect("uses each terminal's working directory arguments", () =>
    Effect.gen(function* () {
      const wezterm = yield* resolveTerminalLaunch(
        { cwd: "/tmp/workspace", terminal: "wezterm" },
        "darwin",
        CLI_ONLY_ENV,
      );
      assert.deepEqual(wezterm, {
        command: "wezterm",
        args: ["start", "--cwd", "/tmp/workspace"],
      });

      const gnomeTerminal = yield* resolveTerminalLaunch(
        { cwd: "/tmp/workspace", terminal: "gnome-terminal" },
        "linux",
        CLI_ONLY_ENV,
      );
      assert.deepEqual(gnomeTerminal, {
        command: "gnome-terminal",
        args: ["--working-directory=/tmp/workspace"],
      });
    }),
  );

  it.effect("only reports terminals supported by the current platform", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-test-" });
      yield* fs.writeFileString(path.join(dir, "wezterm"), "#!/bin/sh\nexit 0\n");
      yield* fs.writeFileString(path.join(dir, "wezterm.EXE"), "MZ");
      yield* fs.writeFileString(path.join(dir, "wt.EXE"), "MZ");
      yield* fs.chmod(path.join(dir, "wezterm"), 0o755);

      assert.deepEqual(resolveAvailableTerminals("darwin", { PATH: dir }), ["wezterm"]);
      assert.deepEqual(resolveAvailableTerminals("win32", { PATH: dir, PATHEXT: ".EXE" }), [
        "wezterm",
        "windows-terminal",
      ]);
    }),
  );
});
