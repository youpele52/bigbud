import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeLocalSupervisorControl } from "./localSupervisorControl.ts";

const targetId = `remote-backend:${"a".repeat(32)}`;
const homes: string[] = [];
const shellQuote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;
async function home() {
  const path = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "bb-local-control-"));
  homes.push(path);
  return path;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(homes.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});

describe("local supervisor control", () => {
  it("rejects aliases and other authorities before filesystem writes or process execution", async () => {
    const homeDir = await home();
    const execute = vi.fn();
    const control = makeLocalSupervisorControl({ targetId, homeDir, execute });
    for (const target of ["local", "ssh:fixture", `remote-backend:${"b".repeat(32)}`]) {
      await expect(control.openControl(target)).rejects.toThrow("another authority");
      await expect(control.run(target, "exit 0")).rejects.toThrow("another authority");
    }
    expect(execute).not.toHaveBeenCalled();
    await expect(fs.stat(join(homeDir, ".bigbud"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses only explicit account environment and sh -c without loading login profiles", async () => {
    const homeDir = await home();
    vi.stubEnv("LOCAL_CONTROL_TEST_CREDENTIAL", "must-not-reach-child");
    await fs.writeFile(join(homeDir, ".profile"), "exit 87\n");
    const control = makeLocalSupervisorControl({ targetId, homeDir });
    const result = await control.run(
      targetId,
      'printf "%s\\n%s" "$HOME" "${LOCAL_CONTROL_TEST_CREDENTIAL:-absent}"',
    );
    expect(result.stdout).toBe(`${homeDir}\nabsent`);
    expect((await fs.stat(control.root)).mode & 0o7777).toBe(0o700);
  });

  it("inspects unsafe descendants before creating state and refuses symlink roots", async () => {
    const homeDir = await home();
    await fs.mkdir(join(homeDir, ".bigbud"), { mode: 0o775 });
    await fs.chmod(join(homeDir, ".bigbud"), 0o775);
    const control = makeLocalSupervisorControl({ targetId, homeDir });
    await expect(control.openControl(targetId)).rejects.toThrow("private directories");
    await expect(fs.stat(control.root)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.chmod(join(homeDir, ".bigbud"), 0o700);
    const outside = await home();
    await fs.symlink(outside, control.root);
    await expect(control.openControl(targetId)).rejects.toThrow("private directories");
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("reuses the P4 owned0755 shared parent without changing its mode", async () => {
    const homeDir = await home();
    await fs.mkdir(join(homeDir, ".bigbud"), { mode: 0o755 });
    const control = makeLocalSupervisorControl({ targetId, homeDir });
    await control.openControl(targetId);
    expect((await fs.stat(join(homeDir, ".bigbud"))).mode & 0o7777).toBe(0o755);
    expect((await fs.stat(control.root)).mode & 0o7777).toBe(0o700);
  });

  it("refuses replaced or missing roots without recreating them", async () => {
    const homeDir = await home();
    const control = makeLocalSupervisorControl({ targetId, homeDir });
    await control.openControl(targetId);
    await fs.rename(control.root, `${control.root}-retained`);
    await expect(control.run(targetId, "exit 0")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(control.root)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.mkdir(control.root, { mode: 0o700 });
    await expect(control.openControl(targetId)).rejects.toThrow("root was replaced");
  });

  it("settles real process timeouts and output overflow without truncation acceptance", async () => {
    const control = makeLocalSupervisorControl({ targetId, homeDir: await home() });
    await expect(control.run(targetId, "sleep 2", { timeoutMs: 50 })).rejects.toThrow("timed out");
    await expect(control.run(targetId, "printf 123456789", { maxBufferBytes: 4 })).rejects.toThrow(
      "buffer limit",
    );
    await expect(control.run(targetId, "exit 0", { timeoutMs: 60_001 })).rejects.toThrow(
      "bounded control policy",
    );
    await expect(control.run(targetId, "exit 0", { maxBufferBytes: Number.NaN })).rejects.toThrow(
      "bounded control policy",
    );
  });

  it.each(["timeout", "abort", "overflow"] as const)(
    "stops owned descendants before reporting %s so they cannot write after cancellation",
    async (kind) => {
      const homeDir = await home();
      const sentinel = join(homeDir, "late-write");
      const quoted = shellQuote(sentinel);
      const control = makeLocalSupervisorControl({ targetId, homeDir });
      const abort = new AbortController();
      const timer = kind === "abort" ? setTimeout(() => abort.abort(), 30) : undefined;
      try {
        await expect(
          control.run(
            targetId,
            `(sleep .15; printf late > ${quoted}) & ${kind === "overflow" ? "printf 123456789;" : ""} wait`,
            {
              timeoutMs: kind === "timeout" ? 30 : 1000,
              maxBufferBytes: kind === "overflow" ? 4 : 1024,
              signal: abort.signal,
            },
          ),
        ).rejects.toThrow();
      } finally {
        clearTimeout(timer);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      await expect(fs.stat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("kills its exact owned group if the backend dies while the command is still running", async () => {
    const homeDir = await home();
    const ready = join(homeDir, "ready");
    const late = join(homeDir, "late");
    const group = join(homeDir, "group");
    const script = `printf '%s' "$$" > ${shellQuote(group)}; printf ready > ${shellQuote(ready)}; (sleep .4; printf late > ${shellQuote(late)}) >/dev/null 2>&1 & sleep 3; wait`;
    const runner = new URL("./localSupervisorControl.runner.ts", import.meta.url).href;
    const bootstrap = `const {runLocalSupervisorCommand}=await import(${JSON.stringify(runner)}); await runLocalSupervisorCommand('/bin/sh',['-c',${JSON.stringify(script)}],{cwd:${JSON.stringify(homeDir)},env:{PATH:'/usr/bin:/bin'},timeoutMs:5000,maxBufferBytes:1024});`;
    const backend = spawn(process.execPath, ["--input-type=module", "-e", bootstrap], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let diagnostics = "";
    backend.stderr.on("data", (chunk: Buffer) => {
      diagnostics += chunk.toString();
    });
    const exited = new Promise((resolve) => backend.once("exit", resolve));
    let groupId: number | undefined;
    let lateWrite = false;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          await fs.stat(ready);
          break;
        } catch {}
        if (backend.exitCode !== null) throw new Error(`Fixture backend exited: ${diagnostics}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await fs.readFile(ready, "utf8")).toBe("ready");
      groupId = Number(await fs.readFile(group, "utf8"));
      expect(groupId).toBeGreaterThan(1);
      backend.kill("SIGKILL");
      await exited;
      await new Promise((resolve) => setTimeout(resolve, 700));
      lateWrite = await fs.stat(late).then(
        () => true,
        () => false,
      );
      expect(lateWrite).toBe(false);
    } finally {
      if (backend.exitCode === null && backend.signalCode === null) backend.kill("SIGKILL");
      // The failing historical fixture still holds this exact group leader in its 3s command.
      if (lateWrite && groupId) {
        try {
          process.kill(-groupId, "SIGKILL");
        } catch {}
      }
      await exited;
    }
  });
});
