import { EventEmitter } from "node:events";
import { lstat } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  LOCAL_TERMINAL_HOST_MINIMAL_PATH,
  launchLocalTerminalHost,
  localTerminalHostEnvironment,
  prepareLocalTerminalHostGeneration,
  type LocalTerminalHostSpawn,
} from "./localTerminalHost.launch.ts";
import { localTerminalHostGenerationPaths } from "./localTerminalHost.paths.ts";
import { makeShortTerminalHostRoot } from "./localTerminalHost.testUtils.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function fakeChild(pid = 4242) {
  const emitter = new EventEmitter();
  const calls = { unref: 0, kill: [] as Array<string | number | undefined> };
  const child = Object.assign(emitter, {
    pid,
    exitCode: null,
    signalCode: null,
    unref: () => {
      calls.unref += 1;
    },
    kill: (signal?: NodeJS.Signals | number) => {
      calls.kill.push(signal);
      return true;
    },
  });
  return { child: child as unknown as ReturnType<LocalTerminalHostSpawn>, calls, emitter };
}

async function generationRoot() {
  const root = await makeShortTerminalHostRoot();
  cleanups.push(root.cleanup);
  const generation = localTerminalHostGenerationPaths(root.paths.root, 1);
  await prepareLocalTerminalHostGeneration(root.paths.root, generation);
  return { ...root, generation };
}

describe("local terminal host launch", () => {
  it("passes only a minimal explicit environment", () => {
    const env = localTerminalHostEnvironment(
      {
        HOME: "/home/u",
        USER: "u",
        LOGNAME: "u",
        TMPDIR: "/tmp/u",
        LANG: "en_US.UTF-8",
        LC_CTYPE: "UTF-8",
        PATH: "/opt/secret/bin:/usr/bin",
        AWS_SECRET_ACCESS_KEY: "nope",
        NODE_OPTIONS: "--inspect",
      },
      "/tmp/bbth-x/terminal-host/state-1",
      "linux",
    );
    expect(env).toEqual({
      HOME: "/home/u",
      USER: "u",
      LOGNAME: "u",
      TMPDIR: "/tmp/u",
      LANG: "en_US.UTF-8",
      LC_CTYPE: "UTF-8",
      PATH: LOCAL_TERMINAL_HOST_MINIMAL_PATH,
      BIGBUD_AGENT_STATE_DIR: "/tmp/bbth-x/terminal-host/state-1",
    });
  });

  it("limits macOS malloc magazines for the host process only", () => {
    const darwin = localTerminalHostEnvironment({ HOME: "/Users/u" }, "/tmp/state", "darwin");
    expect(darwin.MallocMaxMagazines).toBe("1");
    const linux = localTerminalHostEnvironment({ HOME: "/home/u" }, "/tmp/state", "linux");
    expect(linux).not.toHaveProperty("MallocMaxMagazines");
  });

  it("creates the generation directory as 0700", async () => {
    const { generation } = await generationRoot();
    expect((await lstat(generation.statePath)).mode & 0o777).toBe(0o700);
  });

  it("daemonizes with detached + unref, logs to host.log, and waits for the socket", async () => {
    const { generation } = await generationRoot();
    const { child, calls } = fakeChild();
    let options: Parameters<LocalTerminalHostSpawn>[2] | undefined;
    let args: ReadonlyArray<string> = [];
    let server: Server | undefined;
    const spawn: LocalTerminalHostSpawn = (_command, spawnArgs, spawnOptions) => {
      args = spawnArgs;
      options = spawnOptions;
      setTimeout(() => {
        server = createServer().listen(generation.socketPath);
      }, 30);
      return child;
    };
    const launched = await launchLocalTerminalHost({
      binaryPath: "/staged/bigbud-remote-agent",
      generation,
      environment: { HOME: "/home/u", SECRET: "x" },
      spawn,
      pollMs: 10,
    });
    cleanups.push(() => new Promise<void>((resolve) => server?.close(() => resolve())));
    expect(launched.pid).toBe(4242);
    expect(args).toEqual([
      "--supervisor",
      "--local-desktop-host",
      "--exit-when-orphaned-and-empty",
    ]);
    expect(options?.detached).toBe(true);
    expect(options?.stdio?.[0]).toBe("ignore");
    expect(options?.env?.SECRET).toBeUndefined();
    expect(options?.env?.BIGBUD_AGENT_STATE_DIR).toBe(generation.statePath);
    expect(calls.unref).toBe(1);
    expect((await lstat(generation.logPath)).mode & 0o777).toBe(0o600);
  });

  it("fails when the host exits during startup", async () => {
    const { generation } = await generationRoot();
    const { child, emitter } = fakeChild();
    const spawn: LocalTerminalHostSpawn = () => {
      setTimeout(() => emitter.emit("exit", 1, null), 10);
      return child;
    };
    await expect(
      launchLocalTerminalHost({ binaryPath: "/x", generation, spawn, pollMs: 5 }),
    ).rejects.toThrow("exited during startup");
  });

  it("stops its own socketless fresh host after the 5 s window", async () => {
    const { generation } = await generationRoot();
    const { child, calls } = fakeChild();
    await expect(
      launchLocalTerminalHost({
        binaryPath: "/x",
        generation,
        spawn: () => child,
        socketWaitMs: 40,
        pollMs: 5,
      }),
    ).rejects.toThrow("did not appear");
    expect(calls.kill).toEqual(["SIGTERM"]);
  });
});
