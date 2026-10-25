// Dev-only Electron launcher. The stop/restart state machine lives in
// scripts/lib/dev-electron-launcher.ts; this file only wires the real host.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, unwatchFile, watchFile } from "node:fs";
import { join, resolve } from "node:path";

import { DEV_RUNNER_PID_ENV } from "@bigbud/shared/DevLauncher";

import { DevElectronLauncher } from "../../../scripts/lib/dev-electron-launcher.ts";
import {
  killTreeWindows,
  listProcesses,
  processAlive,
} from "../../../scripts/lib/dev-process-tree.ts";
import { prepareDevSystemMonitorEnv } from "./dev-system-monitor.mjs";
import { desktopDir, resolveElectronPath } from "./electron-launcher.mjs";
import { waitForResources } from "./wait-for-resources.mjs";

const port = Number(process.env.ELECTRON_RENDERER_PORT ?? 5733);
const devServerUrl = `http://localhost:${port}`;
const requiredFiles = [
  "dist-electron/main.js",
  "dist-electron/preload.js",
  "../server/dist/bin.mjs",
];
// Bun's directory fs.watch drops per-file events during multi-file rebuilds (tsdown writes the
// bundle and ~20 chunks at once), so restarts were missed. Poll the outputs' stats instead.
const BUILD_OUTPUT_POLL_MS = 300;
const windows = process.platform === "win32";
// The bigbud server's entry point, as it appears on its command line.
const backendEntry = "server/dist/bin.mjs";

await waitForResources({
  baseDir: desktopDir,
  files: requiredFiles,
  tcpPort: port,
});

const childEnv = prepareDevSystemMonitorEnv(process.env, resolve(desktopDir, "../.."));
delete childEnv.ELECTRON_RUN_AS_NODE;
// Only this launcher may end the dev session. Terminals inside the dev app must not inherit it.
delete childEnv[DEV_RUNNER_PID_ENV];

const devRunnerPid = Number.parseInt(process.env[DEV_RUNNER_PID_ENV] ?? "", 10);
const watchers = [];

function cleanupStaleDevApps() {
  if (windows) {
    return;
  }

  spawnSync("pkill", ["-f", "--", `--t3code-dev-root=${desktopDir}`], { stdio: "ignore" });
}

const launcher = new DevElectronLauncher({
  windows,
  launcherPid: process.pid,
  devRunnerPid: Number.isInteger(devRunnerPid) && devRunnerPid > 0 ? devRunnerPid : undefined,
  spawnApp() {
    const app = spawn(
      resolveElectronPath(true),
      ["--no-deprecation", `--t3code-dev-root=${desktopDir}`, "dist-electron/main.js"],
      {
        cwd: desktopDir,
        env: {
          ...childEnv,
          VITE_DEV_SERVER_URL: devServerUrl,
        },
        stdio: "inherit",
      },
    );
    return {
      pid: app.pid,
      onExit: (listener) => {
        app.once("exit", listener);
      },
      onError: (listener) => {
        app.once("error", listener);
      },
    };
  },
  listProcesses: () => listProcesses(),
  findBackend(candidates) {
    if (windows || candidates.length === 0) {
      return undefined;
    }
    const listing = spawnSync("ps", ["-o", "pid=,command=", "-p", candidates.join(",")], {
      encoding: "utf8",
    });
    for (const line of (listing.stdout ?? "").split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (match && match[2].includes(backendEntry)) {
        return Number(match[1]);
      }
    }
    return undefined;
  },
  signal: (pid, signal) => {
    process.kill(pid, signal);
  },
  killTree: killTreeWindows,
  alive: processAlive,
  now: () => Date.now(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (timer) => clearTimeout(timer),
  log: (message) => process.stderr.write(`${message}\n`),
  closeWatchers() {
    for (const file of watchers) {
      unwatchFile(file);
    }
  },
  exit: (code) => process.exit(code),
});

function startWatchers() {
  for (const relativePath of requiredFiles) {
    const file = join(desktopDir, relativePath);
    watchFile(file, { persistent: true, interval: BUILD_OUTPUT_POLL_MS }, (current, previous) => {
      if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) {
        return;
      }
      // A clean rebuild deletes outputs first; the recreating write triggers the restart.
      if (!requiredFiles.every((path) => existsSync(join(desktopDir, path)))) {
        return;
      }

      launcher.onBuildOutputChanged();
    });

    watchers.push(file);
  }
}

startWatchers();
cleanupStaleDevApps();
launcher.start();

process.once("SIGINT", () => {
  void launcher.shutdown(130);
});
process.once("SIGTERM", () => {
  void launcher.shutdown(143);
});
process.once("SIGHUP", () => {
  void launcher.shutdown(129);
});
