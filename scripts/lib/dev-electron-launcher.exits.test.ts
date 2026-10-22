import {
  DEV_APP_DUPLICATE_INSTANCE_EXIT_CODE,
  DEV_APP_FATAL_EXIT_CODE,
  DEV_APP_RESTART_EXIT_CODE,
} from "@bigbud/shared/DevLauncher";
import { describe, expect, it } from "vitest";

import { DevElectronLauncher } from "./dev-electron-launcher.ts";
import {
  DEV_ELECTRON_GRACEFUL_STOP_MS,
  DEV_ELECTRON_RESTART_DEBOUNCE_MS,
  DEV_ELECTRON_SNAPSHOT_INTERVAL_MS,
} from "./dev-electron-launcher.model.ts";
import {
  fakeLauncherHost,
  RUNNER_PID,
  sent,
  startWithTree,
  type FakeLauncherHost,
} from "./dev-electron-launcher.test.helpers.ts";

/** The app runs long enough for a rolling snapshot, then exits on its own with `code`. */
async function appExitsMidTeardown(
  fake: FakeLauncherHost,
  code: number,
  serverOutcome: "finishes" | "dies" = "finishes",
) {
  const tree = startWithTree(fake);
  await fake.advance(DEV_ELECTRON_SNAPSHOT_INTERVAL_MS);
  // Electron SIGTERMed its backend and quit; the server is still stopping its providers.
  fake.kill(tree.app, code, null);
  fake.later(1_000, () => {
    if (serverOutcome === "finishes") fake.kill(tree.provider);
    fake.kill(tree.server);
  });
  return tree;
}

describe("DevElectronLauncher reaps exits it did not request", () => {
  it("lets a quit app's backend finish, then ends the dev session through dev-runner", async () => {
    const fake = fakeLauncherHost();
    await appExitsMidTeardown(fake, 0);

    await fake.advance(500);
    expect(fake.signals).toEqual([]);
    await fake.advance(600);
    expect(fake.signals).toEqual([[RUNNER_PID, "SIGINT"]]);
    expect(fake.state).toEqual({ exitCode: 0, watchersClosed: true });
    expect(fake.logs.some((line) => line.startsWith("[dev-electron] reap graceful"))).toBe(true);
  });

  it("SIGKILLs providers stranded by a backend that died after the user quit", async () => {
    const fake = fakeLauncherHost();
    const { provider } = await appExitsMidTeardown(fake, 0, "dies");

    await fake.advance(DEV_ELECTRON_GRACEFUL_STOP_MS + 100);
    expect(sent(fake, "SIGKILL")).toEqual([provider]);
    expect(sent(fake, "SIGINT")).toEqual([RUNNER_PID]);
    expect(fake.appPids()).toHaveLength(1);
  });

  it("relaunches on the restart sentinel only after the old tree has drained", async () => {
    const fake = fakeLauncherHost();
    await appExitsMidTeardown(fake, DEV_APP_RESTART_EXIT_CODE);

    await fake.advance(500);
    expect(fake.appPids()).toHaveLength(1);
    await fake.advance(600);
    expect(fake.appPids()).toHaveLength(2);
    expect(fake.signals).toEqual([]);
    expect(fake.state.exitCode).toBeNull();
  });

  it("asks the children of a crashed Electron to stop, then relaunches", async () => {
    const fake = fakeLauncherHost();
    const { app, server, provider } = startWithTree(fake);
    fake.setOnSignal((pid, signal) => {
      if (signal === "SIGTERM" && pid === server)
        fake.later(500, () => {
          fake.kill(provider);
          fake.kill(server);
        });
    });
    await fake.advance(DEV_ELECTRON_SNAPSHOT_INTERVAL_MS);
    fake.kill(app, null, "SIGSEGV");

    await fake.advance(700);
    expect(fake.signals).toEqual([[server, "SIGTERM"]]);
    expect(fake.appPids()).toHaveLength(2);
  });

  it("reaps after a fatal error, stays idle, and relaunches on the next rebuild", async () => {
    const fake = fakeLauncherHost();
    const { launcher, provider } = await appExitsMidTeardown(fake, DEV_APP_FATAL_EXIT_CODE, "dies");

    await fake.advance(DEV_ELECTRON_GRACEFUL_STOP_MS + 100);
    expect(sent(fake, "SIGKILL")).toEqual([provider]);
    expect(fake.appPids()).toHaveLength(1);
    expect(fake.state.exitCode).toBeNull();

    launcher.onBuildOutputChanged();
    await fake.advance(DEV_ELECTRON_RESTART_DEBOUNCE_MS);
    expect(fake.appPids()).toHaveLength(2);
  });

  it("stays idle when another dev instance holds the lock, until the next rebuild", async () => {
    const fake = fakeLauncherHost();
    const launcher = new DevElectronLauncher(fake.host);
    launcher.start();
    fake.kill(fake.appPids()[0]!, DEV_APP_DUPLICATE_INSTANCE_EXIT_CODE, null);

    await fake.advance(DEV_ELECTRON_GRACEFUL_STOP_MS);
    expect(fake.appPids()).toHaveLength(1);
    expect(fake.signals).toEqual([]);
    expect(fake.state.exitCode).toBeNull();
    launcher.onBuildOutputChanged();
    await fake.advance(DEV_ELECTRON_RESTART_DEBOUNCE_MS);
    expect(fake.appPids()).toHaveLength(2);
  });

  it("leaves a process that daemonized away from the app tree alone", async () => {
    const fake = fakeLauncherHost();
    const { app, server, provider } = startWithTree(fake);
    const daemon = fake.spawnChild(server);
    fake.reparent(daemon);
    await fake.advance(DEV_ELECTRON_SNAPSHOT_INTERVAL_MS);
    fake.kill(app, DEV_APP_FATAL_EXIT_CODE, null);
    fake.later(300, () => fake.kill(server));

    await fake.advance(DEV_ELECTRON_GRACEFUL_STOP_MS + 600);
    expect(sent(fake, "SIGKILL")).toEqual([provider]);
    expect(fake.isAlive(daemon)).toBe(true);
  });
});

describe("DevElectronLauncher ending the dev session", () => {
  it("does not signal a dev runner that is not its ancestor", async () => {
    const fake = fakeLauncherHost({ devRunnerPid: 4_242 });
    await appExitsMidTeardown(fake, 0);
    await fake.advance(DEV_ELECTRON_GRACEFUL_STOP_MS);

    expect(sent(fake, "SIGINT")).toEqual([]);
    expect(fake.state.exitCode).toBe(0);
  });

  it("stops only itself when no dev runner is known", async () => {
    const fake = fakeLauncherHost({ devRunnerPid: undefined });
    await appExitsMidTeardown(fake, 0);
    await fake.advance(DEV_ELECTRON_GRACEFUL_STOP_MS);

    expect(fake.signals).toEqual([]);
    expect(fake.state.exitCode).toBe(0);
  });

  it("ends the dev runner's tree with taskkill on Windows", async () => {
    const fake = fakeLauncherHost({ windows: true });
    new DevElectronLauncher(fake.host).start();
    fake.kill(fake.appPids()[0]!, 0, null);
    await fake.advance(0);

    expect(fake.killedTrees).toEqual([RUNNER_PID]);
    expect(fake.signals).toEqual([]);
  });
});
