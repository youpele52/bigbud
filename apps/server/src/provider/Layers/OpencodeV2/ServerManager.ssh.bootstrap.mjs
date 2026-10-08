// Fixed remote program: secret material arrives through SSH stdin, never argv.
import { spawn, spawnSync } from "node:child_process";
import {
  mkdir,
  realpath,
  writeFile,
  readFile,
  unlink,
  open as openPlugin,
  rename,
} from "node:fs/promises";
import { constants as pluginConstants } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { inspectPrivateV2Profile } from "./ProfileIsolation.mjs";

let buffered = "";
let started = false;
let child;
let stopping = false;
let ownedPluginPath;
let ownedPluginSource;
let nonce;
function stop() {
  if (stopping) return;
  stopping = true;
  child?.stdin.end();
  const term = setTimeout(() => child?.kill("SIGTERM"), 1000);
  const kill = setTimeout(() => child?.kill("SIGKILL"), 2000);
  child?.once("exit", () => {
    clearTimeout(term);
    clearTimeout(kill);
  });
  term.unref();
  kill.unref();
}
process.stdin.on("end", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.stdin.on("data", async (chunk) => {
  if (started || stopping) return;
  buffered += chunk.toString("utf8");
  if (Buffer.byteLength(buffered) > 16384) {
    process.exitCode = 1;
    process.stdin.destroy();
    return;
  }
  const newline = buffered.indexOf("\n");
  if (newline < 0) return;
  started = true;
  try {
    const input = JSON.parse(buffered.slice(0, newline));
    buffered = "";
    if (
      process.platform === "win32" ||
      !path.isAbsolute(input.binaryPath) ||
      !path.isAbsolute(input.profileRoot) ||
      typeof input.password !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.password)
    )
      throw new Error("bootstrap input rejected");
    if (input.nonce !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(input.nonce))
      throw new Error("lease nonce rejected");
    nonce = input.nonce;
    let created = false;
    try {
      await mkdir(input.profileRoot, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (created && input.application)
      await writeFile(
        path.join(input.profileRoot, ".bigbud-opencode-v2"),
        "bigbud-opencode-v2-owned-v1\n",
        { flag: "wx", mode: 0o600 },
      );
    if ((await realpath(input.profileRoot)) !== path.resolve(input.profileRoot))
      throw new Error("profile symlink rejected");
    const inspection = new AbortController();
    const inspectionTimer = setTimeout(() => {
      inspection.abort();
      stop();
      process.exitCode = 1;
      process.stdin.destroy();
    }, 5000);
    try {
      await inspectPrivateV2Profile(input.profileRoot, {
        signal: inspection.signal,
        ...(input.application ? { application: true } : {}),
      });
      if (input.workspaceRoot) {
        const workspace = await realpath(input.workspaceRoot);
        if (workspace !== path.resolve(input.workspaceRoot))
          throw new Error("workspace symlink rejected");
        const inside = (a, b) => {
          const relative = path.relative(a, b);
          return (
            !relative ||
            (relative !== ".." &&
              !relative.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relative))
          );
        };
        if (inside(workspace, input.profileRoot) || inside(input.profileRoot, workspace))
          throw new Error("workspace/runtime storage overlap rejected");
      }
      if (input.pluginSource !== undefined) {
        const marker = "// bigbud-coding-owned-v1 ";
        if (
          typeof input.pluginSource !== "string" ||
          input.pluginSource.length > 10000 ||
          !input.pluginSource.startsWith(marker)
        )
          throw new Error("plugin payload rejected");
        const metadata = JSON.parse(input.pluginSource.split("\n")[0].slice(marker.length));
        const endpoint = new URL(metadata.url);
        if (
          endpoint.protocol !== "http:" ||
          endpoint.hostname !== "127.0.0.1" ||
          endpoint.pathname !== "/invoke" ||
          !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/invoke$/.test(metadata.url) ||
          !/^[0-9a-f]{64}$/.test(metadata.token)
        )
          throw new Error("plugin callback rejected");
        const directory = path.join(input.profileRoot, "config", "opencode", "plugins");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await inspectPrivateV2Profile(input.profileRoot, { marker: false });
        ownedPluginPath = path.join(directory, "bigbud-coding-owned.js");
        try {
          const handle = await openPlugin(
            ownedPluginPath,
            pluginConstants.O_RDONLY | pluginConstants.O_NOFOLLOW | pluginConstants.O_NONBLOCK,
          );
          let prior;
          try {
            const info = await handle.stat();
            if (!info.isFile() || info.nlink !== 1 || info.size > 10000)
              throw new Error("owned coding plugin upgrade rejected: file provenance");
            prior = await handle.readFile("utf8");
          } finally {
            await handle.close();
          }
          if (!prior.startsWith(marker) || prior.length > 10000)
            throw new Error("plugin collision");
          const previous = JSON.parse(prior.split("\n")[0].slice(marker.length));
          const previousEndpoint = new URL(previous.url);
          if (
            previousEndpoint.protocol !== "http:" ||
            previousEndpoint.hostname !== "127.0.0.1" ||
            previousEndpoint.pathname !== "/invoke" ||
            !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/invoke$/.test(previous.url) ||
            !/^[0-9a-f]{64}$/.test(previous.token)
          )
            throw new Error("owned coding plugin upgrade rejected: invalid callback metadata");
          const translated = prior
            .replace(prior.split("\n")[0], () => input.pluginSource.split("\n")[0])
            .replace(JSON.stringify(previous.url), () => JSON.stringify(metadata.url))
            .replace(JSON.stringify(`Bearer ${previous.token}`), () =>
              JSON.stringify(`Bearer ${metadata.token}`),
            );
          if (translated !== input.pluginSource && translated !== input.previousPluginSource)
            throw new Error("owned coding plugin upgrade rejected: unsupported exact template");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        ownedPluginSource = input.pluginSource;
        const temporary = `${ownedPluginPath}.${randomBytes(16).toString("hex")}`;
        try {
          await writeFile(temporary, ownedPluginSource, { mode: 0o600, flag: "wx" });
          await rename(temporary, ownedPluginPath);
        } finally {
          await unlink(temporary).catch(() => {});
        }
      }
    } finally {
      clearTimeout(inspectionTimer);
    }
    if (stopping) throw new Error("lease ended during profile inspection");
    const env = {
      PATH: process.env.PATH,
      HOME: input.profileRoot,
      XDG_CONFIG_HOME: path.join(input.profileRoot, "config"),
      XDG_DATA_HOME: path.join(input.profileRoot, "data"),
      XDG_CACHE_HOME: path.join(input.profileRoot, "cache"),
      XDG_STATE_HOME: path.join(input.profileRoot, "state"),
      OPENCODE_CONFIG_DIR: path.join(input.profileRoot, "config", "opencode"),
      OPENCODE_DB: path.join(input.profileRoot, "data", "opencode", "opencode.db"),
      OPENCODE_CONFIG_PROJECT_DISABLE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_PASSWORD: input.password,
    };
    input.password = "";
    const version = spawnSync(input.binaryPath, ["--version"], {
      env,
      cwd: input.profileRoot,
      shell: false,
      timeout: 5000,
      maxBuffer: 1024,
    });
    if (version.status !== 0 || !/^(?:opencode v)?2\.0\.19\s*$/.test(String(version.stdout)))
      throw new Error("version rejected");
    if (stopping) throw new Error("lease ended");
    child = spawn(input.binaryPath, ["serve", "--stdio", "--hostname=127.0.0.1", "--port=0"], {
      env,
      cwd: input.profileRoot,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    env.OPENCODE_PASSWORD = "";
    child.stderr.resume();
    child.stdin.on("error", () => {});
    let output = "";
    let ready = false;
    const timer = setTimeout(() => {
      stop();
      process.exitCode = 1;
    }, 10000);
    child.stdout.on("data", (chunk) => {
      if (ready) return;
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > 16384) {
        stop();
        process.exitCode = 1;
        return;
      }
      const end = output.indexOf("\n");
      if (end < 0) return;
      try {
        const line = JSON.parse(output.slice(0, end));
        const url = new URL(line.url);
        if (
          url.protocol !== "http:" ||
          url.hostname !== "127.0.0.1" ||
          !url.port ||
          url.username ||
          url.password ||
          url.pathname !== "/" ||
          url.search ||
          url.hash
        )
          throw new Error("endpoint rejected");
        ready = true;
        clearTimeout(timer);
        process.stdout.write(JSON.stringify({ url: url.origin, pid: child.pid, nonce }) + "\n");
      } catch {
        stop();
        process.exitCode = 1;
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      process.exitCode = 1;
      process.stdin.destroy();
    });
    child.on("exit", async (code, signal) => {
      clearTimeout(timer);
      process.stdout.write(
        JSON.stringify({ type: "native-exited", pid: child.pid, nonce, code, signal }) + "\n",
      );
      if (ownedPluginPath) {
        try {
          if ((await readFile(ownedPluginPath, "utf8")) === ownedPluginSource)
            await unlink(ownedPluginPath);
        } catch {
          /* Native exit proof does not imply destructive cleanup. */
        }
      }
      process.stdin.destroy();
    });
  } catch {
    process.stderr.write("OpenCode v2 protected bootstrap failed.\n");
    process.exitCode = 1;
    process.stdin.destroy();
    stop();
  }
});
