import { spawn, spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { join } from "node:path";

import { desktopDir, resolveDevelopmentElectronLaunch } from "./electron-launcher.mjs";
import { waitForResources } from "./wait-for-resources.mjs";

const port = Number(process.env.ELECTRON_RENDERER_PORT ?? 5733);
const devServerUrl = `http://localhost:${port}`;
const requiredFiles = [
  "dist-electron/main.js",
  "dist-electron/preload.js",
  "../server/dist/bin.mjs",
];
const watchedDirectories = [
  { directory: "dist-electron", files: new Set(["main.js", "preload.js"]) },
  { directory: "../server/dist", files: new Set(["bin.mjs"]) },
];
const forcedShutdownTimeoutMs = 1_500;
const restartDebounceMs = 120;
const childTreeGracePeriodMs = 1_200;
const devAppMarker = `--t3code-dev-root=${desktopDir}`;

await waitForResources({
  baseDir: desktopDir,
  files: requiredFiles,
  tcpPort: port,
});

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

let shuttingDown = false;
let restartTimer = null;
let currentApp = null;
let currentLogTail = null;
let restartQueue = Promise.resolve();
const expectedExits = new WeakSet();
const watchers = [];

function killChildTreeByPid(pid, signal) {
  if (process.platform === "win32" || typeof pid !== "number") {
    return;
  }

  spawnSync("pkill", [`-${signal}`, "-P", String(pid)], { stdio: "ignore" });
}

function killTaggedDevApp(signal) {
  if (process.platform !== "darwin") {
    return;
  }

  spawnSync("pkill", [`-${signal}`, "-f", "--", devAppMarker], {
    stdio: "ignore",
  });
}

function cleanupStaleDevApps() {
  if (process.platform === "win32") {
    return;
  }

  spawnSync("pkill", ["-f", "--", devAppMarker], { stdio: "ignore" });
}

function startMacDevAppWatchdog() {
  if (process.platform !== "darwin") {
    return;
  }

  spawn(
    process.execPath,
    [
      join(desktopDir, "scripts", "macos-dev-app-watchdog.mjs"),
      String(process.pid),
      Buffer.from(devAppMarker).toString("base64"),
    ],
    { detached: true, stdio: "ignore" },
  ).unref();
}

function startApp() {
  if (shuttingDown || currentApp !== null) {
    return;
  }

  const appEnvironment = {
    ...childEnv,
    VITE_DEV_SERVER_URL: devServerUrl,
  };
  const launch = resolveDevelopmentElectronLaunch(
    ["--no-deprecation", devAppMarker, join(desktopDir, "dist-electron", "main.js")],
    appEnvironment,
  );
  const app = spawn(launch.command, launch.args, {
    cwd: desktopDir,
    env: appEnvironment,
    stdio: "inherit",
  });
  if (launch.logPaths) {
    currentLogTail = spawn("tail", ["-q", "-n", "+1", "-F", ...launch.logPaths], {
      stdio: ["ignore", "inherit", "inherit"],
    });
  }

  currentApp = app;

  app.once("error", () => {
    if (currentApp === app) {
      currentApp = null;
    }
    stopLogTail();

    if (!shuttingDown) {
      scheduleRestart();
    }
  });

  app.once("exit", (code, signal) => {
    if (currentApp === app) {
      currentApp = null;
    }
    stopLogTail();

    const exitedAbnormally = signal !== null || code !== 0;
    if (!shuttingDown && !expectedExits.has(app) && exitedAbnormally) {
      scheduleRestart();
    }
  });
}

function stopLogTail() {
  currentLogTail?.kill("SIGTERM");
  currentLogTail = null;
}

async function stopApp() {
  const app = currentApp;
  if (!app) {
    return;
  }

  currentApp = null;
  expectedExits.add(app);
  stopLogTail();

  await new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      resolve();
    };

    app.once("exit", finish);
    killTaggedDevApp("TERM");
    app.kill("SIGTERM");
    killChildTreeByPid(app.pid, "TERM");

    setTimeout(() => {
      if (settled) {
        return;
      }

      killTaggedDevApp("KILL");
      app.kill("SIGKILL");
      killChildTreeByPid(app.pid, "KILL");
      finish();
    }, forcedShutdownTimeoutMs).unref();
  });
}

function scheduleRestart() {
  if (shuttingDown) {
    return;
  }

  if (restartTimer) {
    clearTimeout(restartTimer);
  }

  restartTimer = setTimeout(() => {
    restartTimer = null;
    restartQueue = restartQueue
      .catch(() => undefined)
      .then(async () => {
        await stopApp();
        if (!shuttingDown) {
          startApp();
        }
      });
  }, restartDebounceMs);
}

function startWatchers() {
  for (const { directory, files } of watchedDirectories) {
    const watcher = watch(
      join(desktopDir, directory),
      { persistent: true },
      (_eventType, filename) => {
        if (typeof filename !== "string" || !files.has(filename)) {
          return;
        }

        scheduleRestart();
      },
    );

    watchers.push(watcher);
  }
}

function killChildTree(signal) {
  if (process.platform === "win32") {
    return;
  }

  // Kill direct children as a final fallback in case normal shutdown leaves stragglers.
  spawnSync("pkill", [`-${signal}`, "-P", String(process.pid)], { stdio: "ignore" });
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  for (const watcher of watchers) {
    watcher.close();
  }

  await stopApp();
  killChildTree("TERM");
  await new Promise((resolve) => {
    setTimeout(resolve, childTreeGracePeriodMs);
  });
  killChildTree("KILL");

  process.exit(exitCode);
}

startWatchers();
cleanupStaleDevApps();
startMacDevAppWatchdog();
startApp();

process.once("SIGINT", () => {
  void shutdown(130);
});
process.once("SIGTERM", () => {
  void shutdown(143);
});
process.once("SIGHUP", () => {
  void shutdown(129);
});
