import { mkdir, readFile, realpath, symlink, writeFile, link } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { runV2ContainedShell } from "./Execution.sandbox.ts";

const python = "/Library/Developer/CommandLineTools/usr/bin/python3";
it("unsupported platforms reject before touching workspace or dispatching", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    for (const platform of ["linux", "win32"]) {
      Object.defineProperty(process, "platform", { ...descriptor, value: platform });
      await expect(
        runV2ContainedShell({
          root: "/not-a-workspace",
          profile: "/not-a-profile",
          command: "printf unsafe",
          beforeSpawn: async () => {
            throw new Error("dispatch must not occur");
          },
        }),
      ).rejects.toThrow("no unrestricted fallback");
    }
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

it.skipIf(process.platform !== "darwin")(
  "overflow rejects and timeout physically terminates an ignoring interpreter",
  async () => {
    await withV2RuntimeFixture(async ({ runtime, directory }) => {
      const root = await realpath(directory),
        profile = await realpath(runtime.options.config.profileRoot);
      await writeFile(
        path.join(root, "overflow.py"),
        "import sys\nsys.stdout.write('x'*140000)\nsys.stdout.flush()\n",
      );
      await expect(
        runV2ContainedShell({
          root,
          profile,
          command: `exec ${python} -I -S overflow.py`,
          beforeSpawn: async () => () => {},
        }),
      ).rejects.toThrow("output exceeded bound");
      await writeFile(
        path.join(root, "timeout.py"),
        "import signal,time,pathlib\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\ntime.sleep(35)\npathlib.Path('late-timeout').write_text('unsafe')\n",
      );
      const result = JSON.parse(
        (
          await runV2ContainedShell({
            root,
            profile,
            command: `exec ${python} -I -S timeout.py`,
            beforeSpawn: async () => () => {},
          })
        ).content!,
      );
      expect(result).toMatchObject({ cancelled: true, signal: "SIGKILL" });
      await expect(readFile(path.join(root, "late-timeout"))).rejects.toThrow();
    });
  },
  45000,
);
it.skipIf(process.platform !== "darwin")(
  "actual kernel sandbox runs project code/mkdir, denies outside/profile/metadata/network/fork and has no unrestricted fallback",
  async () => {
    await withV2RuntimeFixture(async ({ runtime, directory }) => {
      const root = await realpath(directory),
        profile = await realpath(runtime.options.config.profileRoot);
      const outside = path.join(path.dirname(root), "outside.txt");
      await writeFile(outside, "OUTSIDE");
      await writeFile(path.join(profile, "secret"), "PROFILE");
      await symlink(path.dirname(root), path.join(root, "escape"));
      await mkdir(path.join(root, ".git"));
      const script = `import os, socket, pathlib, unittest\nroot=pathlib.Path(${JSON.stringify(root)})\n(root/'created').mkdir()\n(root/'created'/'result.txt').write_text('actual project execution')\nblocked=[]\nfor target in [${JSON.stringify(outside)}, ${JSON.stringify(path.join(profile, "secret"))}, str(root/'escape'/'outside.txt')]:\n try: open(target).read(); raise AssertionError('read escaped: '+target)\n except PermissionError: blocked.append(target)\nfor target in [${JSON.stringify(outside)}, ${JSON.stringify(path.join(profile, "secret"))}, str(root/'.git'/'config')]:\n try: open(target,'w').write('escape'); raise AssertionError('write escaped: '+target)\n except PermissionError: pass\ntry: os.fork(); raise AssertionError('fork allowed')\nexcept PermissionError: pass\ntry: os.posix_spawn('/bin/sh', ['/bin/sh', '-c', 'exit 0'], {}); raise AssertionError('posix_spawn allowed')\nexcept PermissionError: pass\ntry: socket.socket().connect(('127.0.0.1',9)); raise AssertionError('network allowed')\nexcept PermissionError: pass\nclass ProjectTest(unittest.TestCase):\n def test_result(self): self.assertEqual((root/'created'/'result.txt').read_text(), 'actual project execution')\nunittest.main()\n`;
      const linkCheck = `\ntry: os.link(${JSON.stringify(outside)}, str(root/'linked-secret')); raise AssertionError('hardlink allowed')\nexcept PermissionError: pass\nalias=pathlib.Path('/System/Volumes/Data'+${JSON.stringify(outside)})\nif alias.exists():\n try: alias.read_text(); raise AssertionError('Data volume alias escaped')\n except PermissionError: pass\n`;
      await writeFile(
        path.join(root, "project_test.py"),
        script.replace("class ProjectTest", () => linkCheck + "class ProjectTest"),
      );
      const result = await runV2ContainedShell({
        root,
        profile,
        command: `exec ${python} -I -S project_test.py`,
        beforeSpawn: async () => () => {},
      });
      const output = JSON.parse(result.content!);
      expect(output.exitCode).toBe(0);
      expect(Buffer.from(output.outputBase64, "base64").toString()).toContain("OK");
      expect(await readFile(outside, "utf8")).toBe("OUTSIDE");
      expect(await readFile(path.join(profile, "secret"), "utf8")).toBe("PROFILE");
      expect(await readFile(path.join(root, "created", "result.txt"), "utf8")).toBe(
        "actual project execution",
      );
      await expect(
        runV2ContainedShell({
          root,
          profile,
          command: "printf forbidden",
          beforeSpawn: async () => {
            throw new Error("queued revoked");
          },
        }),
      ).rejects.toThrow("queued revoked");
      await link(outside, path.join(root, "preexisting-alias"));
      await expect(
        runV2ContainedShell({
          root,
          profile,
          command: "printf should-not-start",
          beforeSpawn: async () => () => {},
        }),
      ).rejects.toThrow("multi-link");
    });
  },
);

it.skipIf(process.platform !== "darwin")(
  "cancel waits for physical close, escalates TERM-ignoring contained process and never leaves a background child",
  async () => {
    await withV2RuntimeFixture(async ({ runtime, directory }) => {
      const root = await realpath(directory),
        profile = await realpath(runtime.options.config.profileRoot);
      await writeFile(
        path.join(root, "waiting.py"),
        "import signal,time,pathlib\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\npathlib.Path('ready.txt').write_text('ready')\ntime.sleep(20)\n",
      );
      const controller = new AbortController();
      const executing = runV2ContainedShell({
        root,
        profile,
        command: `exec ${python} -I -S waiting.py`,
        beforeSpawn: async () => () => {},
        signal: controller.signal,
      });
      await expect
        .poll(() => readFile(path.join(root, "ready.txt"), "utf8").catch(() => ""))
        .toBe("ready");
      controller.abort();
      const result = JSON.parse((await executing).content!);
      expect(result.cancelled).toBe(true);
      expect(result.signal).toBe("SIGKILL");
    });
  },
);
