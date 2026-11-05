import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runProcess } from "../utils/processRunner.ts";
import { runCancellableSshToolCommand } from "./toolTransport.ssh.cancellation.ts";
import { runSshCommand } from "../ssh/sshProcess.ts";

vi.mock("../ssh/sshProcess.ts", () => ({ runSshCommand: vi.fn() }));
beforeEach(() => {
  vi.mocked(runSshCommand).mockReset();
});
afterEach(() => vi.restoreAllMocks());

async function withLocalSsh(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ssh-cancel-test-"));
  let env = process.env;
  // macOS lacks setsid. Emulate that utility locally, not the cancellation protocol.
  if (spawnSync("setsid", ["--version"]).error) {
    const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], {
      encoding: "utf8",
    }).trim();
    await writeFile(
      path.join(directory, "setsid"),
      `#!${python}\nimport os,sys\nos.setsid()\nos.execvp(sys.argv[1], sys.argv[1:])\n`,
      { mode: 0o700 },
    );
    env = { ...process.env, PATH: `${directory}:${process.env.PATH}` };
  }
  vi.mocked(runSshCommand).mockImplementation((input) =>
    runProcess(input.command, input.args ?? [], {
      cwd: input.cwd,
      env,
      stdin: input.stdin,
      timeoutMs: input.timeoutMs,
      allowNonZeroExit: input.allowNonZeroExit,
      shell: false,
    }),
  );
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it.skipIf(process.platform === "win32")(
  "kills a TERM-resistant remote command and its child, not merely the SSH observer",
  async () => {
    await withLocalSsh(async (directory) => {
      const marker = path.join(directory, "running");
      const descendant = path.join(directory, "child");
      const controller = new AbortController();
      const command = `trap '' TERM; sh -c 'trap "" TERM; echo $$ > "$1"; while :; do sleep 1; done' child '${descendant}' & echo $$ > '${marker}'; wait`;
      const running = runCancellableSshToolCommand({
        executionTargetId: "ssh:fixture",
        command: "sh",
        args: ["-c", command],
        cwd: directory,
        signal: controller.signal,
        timeoutMs: 10_000,
      });
      const observed = running.catch((cause: unknown) => cause);
      try {
        await expect
          .poll(async () => await readFile(marker, "utf8").catch(() => ""))
          .toMatch(/^\d+/);
        await expect
          .poll(async () => await readFile(descendant, "utf8").catch(() => ""))
          .toMatch(/^\d+/);
        const pids = await Promise.all(
          [marker, descendant].map(async (file) => (await readFile(file, "utf8")).trim()),
        );
        controller.abort();
        expect(String(await observed)).toContain("cancelled");
        for (const pid of pids) {
          const state = spawnSync("ps", ["-o", "stat=", "-p", pid], {
            encoding: "utf8",
          }).stdout.trim();
          expect(state === "" || state.startsWith("Z")).toBe(true);
        }
      } finally {
        controller.abort();
        await observed;
      }
    });
  },
);

it.skipIf(process.platform === "win32")(
  "preserves stdin for remote writes and patch payloads",
  async () => {
    await withLocalSsh(async (directory) => {
      const target = path.join(directory, "written");
      const payload = "line one\nline two 'quoted' ü\n";
      const result = await runCancellableSshToolCommand({
        executionTargetId: "ssh:fixture",
        command: "sh",
        args: ["-c", 'cat > "$1"; cat "$1"', "write", target],
        signal: new AbortController().signal,
        stdin: payload,
      });
      expect(result.stdout).toBe(payload);
      expect(await readFile(target, "utf8")).toBe(payload);
    });
  },
);

it("does not launch SSH for an already-cancelled command", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    runCancellableSshToolCommand({
      executionTargetId: "ssh:fixture",
      command: "touch",
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(runSshCommand).not.toHaveBeenCalled();
});

it.each(["abort", "transport-exit"])(
  "retains remote evidence when %s cannot establish group termination",
  async (mode) => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(runSshCommand).mockImplementation(async (input) => {
      const script = input.args?.[1] ?? "";
      if (script.includes("mkdir -m 700"))
        return { stdout: "", stderr: "", code: 0, signal: null, timedOut: false };
      if (script.includes("setsid sh")) {
        started();
        if (mode === "transport-exit")
          return { stdout: "", stderr: "link lost", code: 255, signal: null, timedOut: false };
        return new Promise(() => {});
      }
      throw new Error("control connection lost");
    });
    const running = runCancellableSshToolCommand({
      executionTargetId: "ssh:fixture",
      command: "sleep",
      signal: controller.signal,
    });
    const observed = running.catch((cause: unknown) => cause);
    await ready;
    if (mode === "abort") controller.abort();
    expect(String(await observed)).toContain("could not be confirmed");
    expect(runSshCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ args: expect.arrayContaining(['rm -rf -- "$1"']) }),
    );
  },
);
