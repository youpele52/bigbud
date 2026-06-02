import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { FileSystem, Path, Effect } from "effect";
import { resolveAvailableEditors, resolveEditorLaunch } from "./open";

it.layer(NodeServices.layer)("resolveEditorLaunch installation evidence", (it) => {
  it.effect("prefers launching installed macOS apps via open", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const applicationsDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-macos-apps-" });
      yield* fs.makeDirectory(path.join(applicationsDir, "Windsurf.app"));

      const launch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "windsurf" },
        "darwin",
        {
          PATH: "",
          BIGBUD_EDITOR_APP_DIRS_DARWIN: applicationsDir,
        },
      );

      assert.deepEqual(launch, {
        command: "open",
        args: [
          "-a",
          path.join(applicationsDir, "Windsurf.app"),
          "--args",
          "--goto",
          "/tmp/workspace/src/open.ts:71:5",
        ],
      });
    }),
  );
});

it.layer(NodeServices.layer)("resolveAvailableEditors installation evidence", (it) => {
  it.effect("uses Windows installation evidence when the editor is not on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-win32-editors-" });
      const executableDir = path.join(root, "Windsurf");
      yield* fs.makeDirectory(executableDir);
      yield* fs.writeFileString(path.join(executableDir, "Windsurf.exe"), "MZ");
      yield* fs.writeFileString(path.join(root, "explorer.CMD"), "MZ");

      const editors = resolveAvailableEditors("win32", {
        PATH: root,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        BIGBUD_EDITOR_APP_DIRS_WIN32: root,
      });

      assert.deepEqual(editors, ["windsurf", "file-manager"]);
    }),
  );

  it.effect("uses Linux desktop entries when the editor launcher is not on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const applicationsDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-linux-apps-" });
      yield* fs.writeFileString(
        path.join(applicationsDir, "windsurf.desktop"),
        "[Desktop Entry]\n",
      );
      yield* fs.writeFileString(path.join(applicationsDir, "xdg-open"), "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(path.join(applicationsDir, "xdg-open"), 0o755);

      const editors = resolveAvailableEditors("linux", {
        PATH: applicationsDir,
        BIGBUD_EDITOR_APP_DIRS_LINUX: applicationsDir,
      });

      assert.deepEqual(editors, ["windsurf", "file-manager"]);
    }),
  );

  it.effect("omits stale macOS shims when the app bundle is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-darwin-bin-" });
      yield* fs.writeFileString(path.join(binDir, "cursor"), "#!/bin/sh\nexit 0\n");
      yield* fs.writeFileString(path.join(binDir, "open"), "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(path.join(binDir, "cursor"), 0o755);
      yield* fs.chmod(path.join(binDir, "open"), 0o755);

      const editors = resolveAvailableEditors("darwin", {
        PATH: binDir,
        BIGBUD_EDITOR_APP_DIRS_DARWIN: path.join(binDir, "Applications"),
      });

      assert.deepEqual(editors, ["file-manager"]);
    }),
  );
});
