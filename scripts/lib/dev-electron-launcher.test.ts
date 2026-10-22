import { describe, expect, it } from "vitest";

import {
  DEV_ELECTRON_APP_QUIT_GRACE_MS,
  DEV_ELECTRON_CHILD_GRACE_MS,
  DEV_ELECTRON_GRACEFUL_STOP_MS,
  DEV_ELECTRON_RESTART_DEBOUNCE_MS,
} from "./dev-electron-launcher.model.ts";
import {
  fakeLauncherHost,
  LAUNCHER_PID,
  sent,
  startWithTree,
} from "./dev-electron-launcher.test.helpers.ts";

describe("DevElectronLauncher rebuild restart", () => {
  it("signals only Electron, waits for the whole tree to drain, then relaunches", async () => {
    const fake = fakeLauncherHost();
    const { launcher, app, server, provider } = startWithTree(fake);
    fake.setOnSignal((pid, signal) => {
      if (signal !== "SIGTERM" || pid !== app) return;
      // Electron forwards one SIGTERM to its backend and quits; the server (reparented to init)
      // finishes its provider teardown one second later.
      fake.kill(app, 0, null);
      fake.later(1_000, () => {
        fake.kill(provider);
        fake.kill(server);
      });
    });

    launcher.onBuildOutputChanged();
    await fake.advance(DEV_ELECTRON_RESTART_DEBOUNCE_MS + 500);
    expect(fake.appPids()).toHaveLength(1);

    await fake.advance(600);
    expect(fake.appPids()).toHaveLength(2);
    // A second SIGTERM would kill the server mid-teardown, so it is never signalled directly.
    expect(fake.signals).toEqual([[app, "SIGTERM"]]);
    expect(fake.logs.some((line) => /stop graceful elapsed=1\d{3}ms/.test(line))).toBe(true);
  });

  it("force-kills provider children reparented to init after the server died mid-teardown", async () => {
    const fake = fakeLauncherHost();
    const { launcher, app, server, provider } = startWithTree(fake);
    fake.setOnSignal((pid, signal) => {
      if (signal !== "SIGTERM" || pid !== app) return;
      fake.kill(app, 0, null);
      fake.later(300, () => fake.kill(server));
    });

    launcher.onBuildOutputChanged();
    await fake.advance(DEV_ELECTRON_RESTART_DEBOUNCE_MS + DEV_ELECTRON_GRACEFUL_STOP_MS - 100);
    expect(fake.isAlive(provider)).toBe(true);
    expect(sent(fake, "SIGKILL")).toEqual([]);

    await fake.advance(200);
    expect(sent(fake, "SIGKILL")).toEqual([provider]);
    expect(fake.isAlive(provider)).toBe(false);
    expect(fake.appPids()).toHaveLength(2);
    expect(fake.logs).toContain(
      `[dev-electron] stop forced elapsed=${DEV_ELECTRON_GRACEFUL_STOP_MS}ms killed=${provider} survivors=none`,
    );
  });

  it("re-lists survivors so children spawned during the graceful window are killed too", async () => {
    const fake = fakeLauncherHost();
    const { launcher, app, server, provider } = startWithTree(fake);
    let late = -1;
    fake.setOnSignal((pid, signal) => {
      if (signal !== "SIGTERM" || pid !== app) return;
      fake.kill(app, 0, null);
      fake.later(1_000, () => (late = fake.spawnChild(server)));
    });

    launcher.onBuildOutputChanged();
    await fake.advance(DEV_ELECTRON_RESTART_DEBOUNCE_MS + DEV_ELECTRON_GRACEFUL_STOP_MS + 600);
    expect(sent(fake, "SIGKILL").toSorted()).toEqual([server, provider, late].toSorted());
    expect([server, provider, late].some((pid) => fake.isAlive(pid))).toBe(false);
  });

  it("kills an Electron that hangs once its backend has drained, not after the full budget", async () => {
    const fake = fakeLauncherHost();
    const { launcher, app, server, provider } = startWithTree(fake);
    fake.setOnSignal((pid, signal) => {
      if (signal !== "SIGTERM" || pid !== app) return;
      // Seen live: the backend stops its providers and exits within ~1.5 s, but Electron's main
      // thread is blocked, so it neither exits nor reaps the server, which stays a zombie.
      fake.later(1_000, () => {
        fake.kill(provider);
        fake.zombify(server);
      });
    });

    launcher.onBuildOutputChanged();
    await fake.advance(
      DEV_ELECTRON_RESTART_DEBOUNCE_MS + 1_000 + DEV_ELECTRON_APP_QUIT_GRACE_MS + 400,
    );
    expect(sent(fake, "SIGKILL")).toEqual([app]);
    expect(fake.appPids()).toHaveLength(2);
    expect(fake.logs).toContain(
      `[dev-electron] stop forced after backend drained elapsed=1600ms killed=${app} survivors=none`,
    );
  });

  it("never SIGKILLs a PID that now names a different process", async () => {
    const fake = fakeLauncherHost();
    const { launcher, app, server, provider } = startWithTree(fake);
    fake.setOnSignal((pid, signal) => {
      if (signal !== "SIGTERM" || pid !== app) return;
      fake.kill(app, 0, null);
      fake.later(300, () => fake.kill(server));
      // The provider exits and its PID is reused by an unrelated process.
      fake.later(1_000, () => fake.reusePid(provider));
    });

    launcher.onBuildOutputChanged();
    await fake.advance(DEV_ELECTRON_RESTART_DEBOUNCE_MS + DEV_ELECTRON_GRACEFUL_STOP_MS + 600);
    expect(sent(fake, "SIGKILL")).toEqual([]);
    expect(fake.isAlive(provider)).toBe(true);
  });

  it("ends the whole tree with taskkill /T /F on Windows instead of POSIX signals", async () => {
    const fake = fakeLauncherHost({ windows: true });
    const { launcher, app, server, provider } = startWithTree(fake);

    launcher.onBuildOutputChanged();
    await fake.advance(DEV_ELECTRON_RESTART_DEBOUNCE_MS);
    expect(fake.killedTrees).toEqual([app]);
    expect(fake.signals).toEqual([]);
    expect([app, server, provider].some((pid) => fake.isAlive(pid))).toBe(false);
    expect(fake.appPids()).toHaveLength(2);
  });
});

describe("DevElectronLauncher shutdown", () => {
  it("joins an in-flight restart, starts nothing new and exits with the signal's code", async () => {
    const fake = fakeLauncherHost();
    const { launcher, app, server, provider } = startWithTree(fake);
    fake.setOnSignal((pid, signal) => {
      if (signal !== "SIGTERM" || pid !== app) return;
      fake.kill(app, 0, null);
      fake.later(1_000, () => {
        fake.kill(provider);
        fake.kill(server);
      });
    });

    launcher.onBuildOutputChanged();
    await fake.advance(DEV_ELECTRON_RESTART_DEBOUNCE_MS + 200);
    void launcher.shutdown(130);
    void launcher.shutdown(143);
    await fake.advance(DEV_ELECTRON_GRACEFUL_STOP_MS);

    expect(fake.appPids()).toHaveLength(1);
    expect(fake.signals).toEqual([[app, "SIGTERM"]]);
    expect(fake.state).toEqual({ exitCode: 130, watchersClosed: true });
  });

  it("stops the app tree, then force-kills anything else the launcher left behind", async () => {
    const fake = fakeLauncherHost();
    const { launcher, app, server, provider } = startWithTree(fake);
    const stray = fake.spawnChild(LAUNCHER_PID);
    fake.setOnSignal((pid, signal) => {
      if (signal !== "SIGTERM" || pid !== app) return;
      fake.kill(provider);
      fake.kill(server);
      fake.kill(app, 0, null);
    });

    void launcher.shutdown(143);
    await fake.advance(DEV_ELECTRON_CHILD_GRACE_MS + 200);
    expect(sent(fake, "SIGTERM")).toEqual([app, stray]);
    expect(sent(fake, "SIGKILL")).toEqual([stray]);
    expect(fake.state.exitCode).toBe(143);
  });
});
