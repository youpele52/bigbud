import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { assertSuccess } from "@effect/vitest/utils";
import { Effect } from "effect";

import { resolveEditorLaunch, resolveTerminalLaunch } from "./open";
import {
  escapeCmdArgument,
  launchDetached,
  resolveSpawnPlan,
  resolveWindowsCmdPath,
} from "./open.launch";
import { makeCommandDirectory, recordingSpawn } from "./open.test.helpers";

const TRICKY_ARGUMENT = '/tmp/My Files/it\'s & "quoted" (1) %PATH% !x! ^ | > ;.ts';
const WINDOWS_TRICKY_PATH = "C:\\My Files\\a&b (1) %PATH% !x! ^;,.ts";
const WIN_ENV = { SystemRoot: "C:\\Windows", PATHEXT: ".COM;.EXE;.BAT;.CMD" };

/** `/tmp/x/code.cmd` → `\tmp\x\code.cmd`, as `path.win32.normalize` produces it. */
const toWindowsSeparators = (value: string) => value.replaceAll("/", "\\");

it.layer(NodeServices.layer)("launchDetached", (it) => {
  it.effect("passes POSIX arguments verbatim without a shell", () =>
    Effect.gen(function* () {
      const dir = yield* makeCommandDirectory(["editor"]);
      const recorder = recordingSpawn();
      const result = yield* launchDetached(
        { command: "editor", args: ["--goto", TRICKY_ARGUMENT] },
        { platform: "linux", env: { PATH: dir }, spawnProcess: recorder.spawnProcess },
      ).pipe(Effect.result);

      assertSuccess(result, undefined);
      assert.equal(recorder.calls.length, 1);
      const [call] = recorder.calls;
      assert.equal(call?.command, `${dir}/editor`);
      assert.deepEqual(call?.args, ["--goto", TRICKY_ARGUMENT]);
      assert.equal(call?.options.shell, false);
      assert.equal(call?.options.detached, true);
    }),
  );

  it.effect("spawns Windows executables directly with Node's own argument quoting", () =>
    Effect.gen(function* () {
      const dir = yield* makeCommandDirectory(["Code.EXE"]);
      const recorder = recordingSpawn();
      const result = yield* launchDetached(
        { command: "Code", args: ["--goto", WINDOWS_TRICKY_PATH] },
        { platform: "win32", env: { ...WIN_ENV, PATH: dir }, spawnProcess: recorder.spawnProcess },
      ).pipe(Effect.result);

      assertSuccess(result, undefined);
      const [call] = recorder.calls;
      assert.equal(call?.command, `${dir}/Code.EXE`);
      assert.deepEqual(call?.args, ["--goto", WINDOWS_TRICKY_PATH]);
      assert.equal(call?.options.shell, false);
      assert.equal(call?.options.windowsVerbatimArguments, false);
    }),
  );

  it.effect("runs Windows .cmd launchers under cmd.exe with every argument escaped", () =>
    Effect.gen(function* () {
      const dir = yield* makeCommandDirectory(["code.CMD"]);
      const recorder = recordingSpawn();
      const result = yield* launchDetached(
        { command: "code", args: ["--goto", WINDOWS_TRICKY_PATH] },
        { platform: "win32", env: { ...WIN_ENV, PATH: dir }, spawnProcess: recorder.spawnProcess },
      ).pipe(Effect.result);

      assertSuccess(result, undefined);
      const [call] = recorder.calls;
      assert.equal(call?.command, "C:\\Windows\\System32\\cmd.exe");
      assert.equal(call?.options.shell, false);
      assert.equal(call?.options.windowsVerbatimArguments, true);
      const escapedPath = '^"C:\\My^ Files\\a^&b^ ^(1^)^ ^%PATH^%^ ^!x^!^ ^^^;^,.ts^"';
      assert.deepEqual(call?.args, [
        "/d",
        "/s",
        "/c",
        `"${toWindowsSeparators(dir)}\\code.CMD ^"--goto^" ${escapedPath}"`,
      ]);
    }),
  );

  it.effect("refuses quotes and line breaks on the cmd.exe path without spawning", () =>
    Effect.gen(function* () {
      const dir = yield* makeCommandDirectory(["code.CMD"]);
      for (const arg of ['C:\\x" & calc & "', "C:\\x\r\ncalc", "C:\\x\ncalc"]) {
        const recorder = recordingSpawn();
        const result = yield* launchDetached(
          { command: "code", args: [arg] },
          {
            platform: "win32",
            env: { ...WIN_ENV, PATH: dir },
            spawnProcess: recorder.spawnProcess,
          },
        ).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.equal(recorder.calls.length, 0);
      }
    }),
  );

  it.effect("passes pre-quoted explorer arguments verbatim and refuses them for .cmd", () =>
    Effect.gen(function* () {
      const dir = yield* makeCommandDirectory(["explorer.EXE", "fm.CMD"]);
      const recorder = recordingSpawn();
      const env = { ...WIN_ENV, PATH: dir };
      const args = ['/select,"C:\\a b\\x,y.exe"'];
      const opened = yield* launchDetached(
        { command: "explorer", args, windowsVerbatimArguments: true },
        { platform: "win32", env, spawnProcess: recorder.spawnProcess },
      ).pipe(Effect.result);
      assertSuccess(opened, undefined);
      assert.deepEqual(recorder.calls[0]?.args, args);
      assert.equal(recorder.calls[0]?.options.windowsVerbatimArguments, true);
      assert.equal(recorder.calls[0]?.options.shell, false);

      const refused = yield* launchDetached(
        { command: "fm", args, windowsVerbatimArguments: true },
        { platform: "win32", env, spawnProcess: recorder.spawnProcess },
      ).pipe(Effect.result);
      assert.equal(refused._tag, "Failure");
      assert.equal(recorder.calls.length, 1);
    }),
  );

  it.effect("fails without spawning when the command is missing", () =>
    Effect.gen(function* () {
      const recorder = recordingSpawn();
      const result = yield* launchDetached(
        { command: "bigbud-no-such-command", args: [] },
        { platform: "linux", env: { PATH: "" }, spawnProcess: recorder.spawnProcess },
      ).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(recorder.calls.length, 0);
    }),
  );

  it.effect("fails when the process emits an error", () =>
    Effect.gen(function* () {
      const dir = yield* makeCommandDirectory(["editor"]);
      const recorder = recordingSpawn(new Error("EACCES"));
      const result = yield* launchDetached(
        { command: "editor", args: [] },
        { platform: "linux", env: { PATH: dir }, spawnProcess: recorder.spawnProcess },
      ).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }),
  );
});

it.layer(NodeServices.layer)("editor and terminal launch composition", (it) => {
  it.effect("composes editor navigation arguments into the cmd.exe command line", () =>
    Effect.gen(function* () {
      const dir = yield* makeCommandDirectory(["code.CMD", "wt.EXE"]);
      const env = { ...WIN_ENV, PATH: dir, BIGBUD_EDITOR_APP_DIRS_WIN32: dir };
      const editor = yield* resolveEditorLaunch(
        { cwd: "C:\\a b\\open.ts:71:5", editor: "vscode" },
        "win32",
        env,
      );
      const editorPlan = resolveSpawnPlan(editor, "win32", env);
      assert.ok(!(editorPlan instanceof Error));
      assert.deepEqual(editorPlan.args.slice(0, 3), ["/d", "/s", "/c"]);
      assert.equal(
        editorPlan.args[3],
        `"${toWindowsSeparators(dir)}\\code.CMD ^"--goto^" ^"C:\\a^ b\\open.ts:71:5^""`,
      );

      const terminal = yield* resolveTerminalLaunch(
        { cwd: "C:\\a b&c", terminal: "windows-terminal" },
        "win32",
        env,
      );
      const terminalPlan = resolveSpawnPlan(terminal, "win32", env);
      assert.ok(!(terminalPlan instanceof Error));
      assert.equal(terminalPlan.command, `${dir}/wt.EXE`);
      assert.deepEqual(terminalPlan.args, ["-d", "C:\\a b&c"]);
      assert.equal(terminalPlan.options.shell, false);
    }),
  );
});

it("escapes cmd arguments per the qntm algorithm", () => {
  assert.equal(escapeCmdArgument("C:\\dir\\"), '^"C:\\dir\\\\^"');
  assert.equal(escapeCmdArgument("plain"), '^"plain^"');
  assert.equal(escapeCmdArgument("a&b|c"), '^"a^&b^|c^"');
});

it("prefers SystemRoot's cmd.exe over ComSpec and never a relative ComSpec", () => {
  assert.equal(
    resolveWindowsCmdPath({ SystemRoot: "C:\\Windows", ComSpec: "D:\\cmd.exe" }),
    "C:\\Windows\\System32\\cmd.exe",
  );
  assert.equal(resolveWindowsCmdPath({ ComSpec: "D:\\cmd.exe" }), "D:\\cmd.exe");
  assert.equal(resolveWindowsCmdPath({ ComSpec: "evil.exe" }), "cmd.exe");
});
