import { realpathSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { assertSuccess } from "@effect/vitest/utils";
import { FileSystem, Path, Effect } from "effect";

import { Open, OpenLive } from "./open";
import { openSystemPath, resolveSystemOpenLaunch } from "./open.systemPath";
import { makeCommandDirectory, recordingSpawn } from "./open.test.helpers";

/** Creates `name` in a fresh temp folder and returns its symlink-free path. */
const makeEntry = Effect.fn("makeEntry")(function* (
  name: string,
  options: { readonly content?: string; readonly mode?: number; readonly directory?: boolean } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-path-" });
  const target = path.join(dir, name);
  if (options.directory) yield* fs.makeDirectory(target);
  else yield* fs.writeFileString(target, options.content ?? "hello");
  if (options.mode !== undefined) yield* fs.chmod(target, options.mode);
  return realpathSync(target);
});

const runOpen = Effect.fn("runOpen")(function* (rawPath: string, platform: "darwin" | "linux") {
  const dir = yield* makeCommandDirectory(["open", "xdg-open"]);
  const recorder = recordingSpawn();
  const result = yield* openSystemPath(rawPath, {
    platform,
    env: { PATH: dir },
    spawnProcess: recorder.spawnProcess,
  }).pipe(Effect.result);
  return { dir, recorder, result };
});

it.layer(NodeServices.layer)("openSystemPath", (it) => {
  it.effect("opens regular files and folders with the macOS default app", () =>
    Effect.gen(function* () {
      for (const target of [
        yield* makeEntry("notes.txt", { mode: 0o644 }),
        yield* makeEntry("My Folder", { directory: true }),
      ]) {
        const { dir, recorder, result } = yield* runOpen(target, "darwin");
        assertSuccess(result, undefined);
        assert.deepEqual(recorder.calls, [
          {
            command: `${dir}/open`,
            args: [target],
            options: { detached: true, stdio: "ignore", shell: false },
          },
        ]);
      }
    }),
  );

  it.effect("reveals launchable targets on macOS and never opens them", () =>
    Effect.gen(function* () {
      const launchable = [
        yield* makeEntry("run.sh", { mode: 0o644 }),
        yield* makeEntry("tool", { mode: 0o755 }),
        yield* makeEntry("script", { content: "#!/bin/sh\necho hi\n", mode: 0o644 }),
        yield* makeEntry("Evil.app", { directory: true }),
      ];
      for (const target of launchable) {
        const { recorder, result } = yield* runOpen(target, "darwin");
        assertSuccess(result, undefined);
        assert.equal(recorder.calls.length, 1);
        assert.deepEqual(recorder.calls[0]?.args, ["-R", target]);
      }
    }),
  );

  it.effect("reveals launchable targets on Linux by opening the containing folder", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const script = yield* makeEntry("install.sh", { mode: 0o644 });
      const revealed = yield* runOpen(script, "linux");
      assertSuccess(revealed.result, undefined);
      assert.equal(revealed.recorder.calls[0]?.command, `${revealed.dir}/xdg-open`);
      assert.deepEqual(revealed.recorder.calls[0]?.args, [path.dirname(script)]);

      const document = yield* makeEntry("report & notes.pdf", { mode: 0o644 });
      const opened = yield* runOpen(document, "linux");
      assertSuccess(opened.result, undefined);
      assert.deepEqual(opened.recorder.calls[0]?.args, [document]);
    }),
  );

  it.effect("refuses relative, missing and device paths without spawning", () =>
    Effect.gen(function* () {
      const missing = `${yield* makeEntry("gone", { directory: true })}/missing.txt`;
      const cases: ReadonlyArray<readonly [string, string]> = [
        ["notes.txt", "Cannot open path: it must be an absolute path to a local file or folder."],
        ["", "Cannot open path: it must be an absolute path to a local file or folder."],
        ["/tmp/a\0b", "Cannot open path: it must be an absolute path to a local file or folder."],
        [missing, "Cannot open path: it does not exist."],
        ["/dev/null", "Cannot open path: only files and folders can be opened."],
      ];
      for (const [rawPath, message] of cases) {
        const { recorder, result } = yield* runOpen(rawPath, "darwin");
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.message, message);
        assert.equal(recorder.calls.length, 0);
      }

      const recorder = recordingSpawn();
      const device = yield* openSystemPath("\\\\.\\PhysicalDrive0", {
        platform: "win32",
        spawnProcess: recorder.spawnProcess,
      }).pipe(Effect.result);
      assert.equal(device._tag, "Failure");
      assert.equal(recorder.calls.length, 0);
    }),
  );
});

it("maps validated Windows paths to quoted explorer arguments", () => {
  const target = { ok: true, realPath: "C:\\a b\\x,y & z.exe", kind: "file" } as const;
  assert.deepEqual(resolveSystemOpenLaunch({ ...target, launchable: true }, "win32"), {
    command: "explorer",
    args: ['/select,"C:\\a b\\x,y & z.exe"'],
    windowsVerbatimArguments: true,
  });
  assert.deepEqual(
    resolveSystemOpenLaunch(
      { ...target, realPath: "C:\\a b\\x,y.txt", launchable: false },
      "win32",
    ),
    { command: "explorer", args: ['"C:\\a b\\x,y.txt"'], windowsVerbatimArguments: true },
  );
  const quoted = resolveSystemOpenLaunch(
    { ...target, realPath: 'C:\\a" & calc', launchable: false },
    "win32",
  );
  assert.ok(quoted instanceof Error);
});

it.layer(NodeServices.layer)("Open service system-open wiring", (it) => {
  it.effect("validates openPath and the file-manager editor before launching anything", () =>
    Effect.gen(function* () {
      const missing = `${yield* makeEntry("gone", { directory: true })}/missing`;
      const open = yield* Open;
      const relative = yield* open.openPath({ path: "relative/notes.txt" }).pipe(Effect.result);
      assert.equal(relative._tag, "Failure");
      const fileManager = yield* open
        .openInEditor({ cwd: missing, editor: "file-manager" })
        .pipe(Effect.result);
      assert.equal(fileManager._tag, "Failure");
      if (fileManager._tag === "Failure") {
        assert.equal(fileManager.failure.message, "Cannot open path: it does not exist.");
      }
    }).pipe(Effect.provide(OpenLive)),
  );
});
