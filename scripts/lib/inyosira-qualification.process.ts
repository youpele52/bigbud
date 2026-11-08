import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
export type NativeProcess = {
  ProcessId: number;
  ParentProcessId: number;
  ExecutablePath: string;
  CommandLine: string;
};

export function qualificationEnvironment(root: string, supervisor: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Keep Windows runtime prerequisites, never provider credentials or inherited bigbud config.
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
    const value = Object.entries(process.env).find(
      ([name]) => name.toLowerCase() === key.toLowerCase(),
    )?.[1];
    if (value) env[key] = value;
  }
  return {
    ...env,
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    APPDATA: join(root, "home", "AppData", "Roaming"),
    LOCALAPPDATA: join(root, "home", "AppData", "Local"),
    BIGBUD_HOME: join(root, "state"),
    BIGBUD_DESKTOP_SUPERVISOR_BINARY: supervisor,
    ELECTRON_RUN_AS_NODE: "1",
    BIGBUD_DESKTOP_PACKAGED: "1",
  };
}

export async function windowsProcesses(): Promise<NativeProcess[]> {
  const { stdout } = await execute(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine)",
    ],
    { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
  );
  return JSON.parse(stdout) as NativeProcess[];
}

export function organizerChildren(processes: NativeProcess[], pid: number, supervisor: string) {
  return processes.filter(
    (entry) =>
      entry.ParentProcessId === pid &&
      entry.ExecutablePath?.toLowerCase() === supervisor.toLowerCase() &&
      entry.CommandLine?.includes("--thread-organization"),
  );
}

async function availablePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address !== "string");
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

export async function startPackagedBackend(
  executable: string,
  entry: string,
  supervisor: string,
  root: string,
) {
  assert.equal(process.platform, "win32", "Requires a disposable native Windows runner");
  assert.equal(process.arch, "x64", "Requires native Windows x64 Node");
  const env = qualificationEnvironment(root, supervisor);
  for (const key of ["HOME", "APPDATA", "LOCALAPPDATA"])
    await mkdir(env[key]!, { recursive: true });
  const port = await availablePort();
  const log = createWriteStream(join(root, "server.log"), { flags: "wx" });
  const child = spawn(
    executable,
    [
      entry,
      "--mode",
      "desktop",
      "--base-dir",
      join(root, "state"),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-browser",
    ],
    {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let spawnError: Error | undefined;
  log.on("error", (error) => {
    spawnError = error;
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const closed = new Promise<void>((resolveClosed) => child.once("close", () => resolveClosed()));
  const alive = () => {
    if (spawnError) throw spawnError;
    assert(
      child.pid && child.exitCode === null && child.signalCode === null,
      "Backend exited unexpectedly",
    );
    return child.pid;
  };
  const nativeProcesses = async () => {
    const processes = await windowsProcesses();
    const pid = alive();
    const organizers = organizerChildren(processes, pid, supervisor);
    assert.equal(
      processes.filter(
        (entry) =>
          entry.ParentProcessId === pid && entry.CommandLine?.includes("--thread-organization"),
      ).length,
      1,
      "Unexpected extra organiser child",
    );
    assert.equal(organizers.length, 1, "Expected one organiser child using packaged path");
    return { processes, organizers };
  };
  return {
    url: `http://127.0.0.1:${port}/`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    alive,
    nativeProcesses,
    async stop() {
      let cleanupFailed = false;
      // Windows TerminateProcess does not deliver POSIX SIGTERM. This verifies
      // bounded parent termination and native EOF cleanup, not graceful shutdown.
      if (child.exitCode === null && child.signalCode === null) child.kill();
      const within = async (timeoutMs: number) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            closed.then(() => true),
            new Promise<false>((done) => {
              timer = setTimeout(() => done(false), timeoutMs);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      if (!(await within(10_000))) {
        cleanupFailed = true;
        if (child.pid)
          await execute("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            timeout: 10_000,
          }).catch(() => undefined);
        assert(await within(5000), "Packaged backend process did not close");
      }
      await new Promise<void>((done, reject) => {
        log.once("error", reject);
        log.end(done);
      });
      const underArtifact = (entry: NativeProcess) =>
        entry.ExecutablePath &&
        resolve(entry.ExecutablePath)
          .toLowerCase()
          .startsWith(`${resolve(executable, "..").toLowerCase()}\\`);
      let remaining: NativeProcess[] = [];
      const deadline = Date.now() + 10_000;
      do {
        remaining = (await windowsProcesses()).filter(underArtifact);
        if (!remaining.length) break;
        await delay(200);
      } while (Date.now() < deadline);
      if (remaining.length) {
        cleanupFailed = true;
        // Exact artifact-directory scope; never kill by executable name.
        for (const entry of remaining)
          await execute("taskkill.exe", ["/PID", String(entry.ProcessId), "/F"], {
            timeout: 5000,
          }).catch(() => undefined);
      }
      if (spawnError) throw spawnError;
      assert(!cleanupFailed, `Qualification required forced cleanup: ${JSON.stringify(remaining)}`);
      return { boundedParentTermination: "PASS", nativeEofCleanup: "PASS", remainingChildren: 0 };
    },
  };
}
