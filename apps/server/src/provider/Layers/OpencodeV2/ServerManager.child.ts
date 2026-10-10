import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import { runWithAbortableDeadline } from "../../RequestDeadline.ts";
import { makeOwnedClient, v2Request, type OpencodeV2Client } from "./Client.ts";
import { assertDevelopmentVersion, validateOwnedEndpoint } from "./Compatibility.ts";
import { inspectPrivateV2Profile } from "./ProfileIsolation.mjs";

export interface V2ProcessConfig {
  readonly sharedService?: import("./SharedService.storage.ts").V2SharedStorage;
  readonly binaryPath: string;
  readonly profileRoot: string;
  readonly runtimeTargetId: string;
  readonly workspaceRoot?: string;
  readonly codingEndpoint?: { readonly url: string; readonly token: string };
}

export interface OwnedV2Process {
  readonly ownership?: "borrowed";
  readonly client: OpencodeV2Client;
  readonly isRunning: () => boolean;
  /** Physical generation-exit proof, not a logical stopping/transport-health flag. */
  readonly hasExited?: () => boolean;
  readonly onDeath: (listener: () => void) => () => void;
  /** Transport loss without native physical-exit proof. Ownership remains live/unknown. */
  readonly onUnavailable?: (listener: () => void) => () => void;
  readonly close: () => Promise<void>;
}

/** Only explicitly isolated roots and a small environment allowlist reach the child. */
export async function isolatedEnvironment(config: V2ProcessConfig): Promise<NodeJS.ProcessEnv> {
  if (config.runtimeTargetId !== "local") {
    throw new Error("OpenCode v2 SSH bootstrap is not yet verified; runtime unavailable.");
  }
  if (
    !path.isAbsolute(config.binaryPath) ||
    !path.isAbsolute(config.profileRoot) ||
    /\.(cmd|bat)$/i.test(config.binaryPath)
  ) {
    throw new Error(
      "OpenCode v2 requires an absolute native executable and isolated profile path.",
    );
  }
  await mkdir(config.profileRoot, { recursive: true, mode: 0o700 });
  if ((await realpath(config.profileRoot)) !== path.resolve(config.profileRoot)) {
    throw new Error("OpenCode v2 profile root must not traverse symlinks.");
  }
  await runWithAbortableDeadline({
    operation: "V2 launcher profile isolation",
    timeoutMs: 5000,
    run: (signal) => inspectPrivateV2Profile(config.profileRoot, { signal, marker: false }),
  });
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TMP",
    "TEMP",
    "TMPDIR",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return {
    ...env,
    HOME: config.profileRoot,
    USERPROFILE: config.profileRoot,
    XDG_CONFIG_HOME: path.join(config.profileRoot, "config"),
    XDG_DATA_HOME: path.join(config.profileRoot, "data"),
    XDG_CACHE_HOME: path.join(config.profileRoot, "cache"),
    XDG_STATE_HOME: path.join(config.profileRoot, "state"),
    OPENCODE_CONFIG_DIR: path.join(config.profileRoot, "config", "opencode"),
    OPENCODE_DB: path.join(config.profileRoot, "data", "opencode", "opencode.db"),
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
  };
}

/** Finite stdin-lease release, then escalation; never delete native history. */
export async function closeOwnedChild(child: ChildProcess): Promise<void> {
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (exited()) return;
  await new Promise<void>((resolve) => {
    let killTimer: ReturnType<typeof setTimeout>;
    let finishTimer: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      clearTimeout(finishTimer);
      child.off("exit", done);
      resolve();
    };
    const termTimer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finishTimer = setTimeout(done, 1000);
      }, 1000);
    }, 1000);
    child.once("exit", done);
    child.stdin?.end();
    if (exited()) done();
  });
}

async function executableVersion(config: V2ProcessConfig, env: NodeJS.ProcessEnv): Promise<string> {
  const child = spawn(config.binaryPath, ["--version"], {
    env,
    cwd: config.profileRoot,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.resume();
  try {
    return await runWithAbortableDeadline({
      operation: "OpenCode v2 version",
      timeoutMs: 5000,
      run: () =>
        new Promise<string>((resolve, reject) => {
          let output = "";
          child.stdout.on("data", (chunk: Buffer) => {
            if (Buffer.byteLength(output) > 1024) return;
            output += chunk.toString("utf8");
            if (Buffer.byteLength(output) > 1024) reject(new Error("Oversized version response."));
          });
          child.once("error", () => reject(new Error("OpenCode v2 executable could not start.")));
          child.once("exit", (code) => {
            const match = /^(?:opencode v)?(2\.\d+\.\d+)\s*$/.exec(output);
            if (code !== 0 || !match?.[1])
              reject(new Error("OpenCode v2 version response rejected."));
            else resolve(match[1]);
          });
        }),
    });
  } finally {
    await closeOwnedChild(child);
  }
}

async function readiness(child: ChildProcess): Promise<string> {
  return runWithAbortableDeadline({
    operation: "OpenCode v2 startup",
    timeoutMs: 10_000,
    run: () =>
      new Promise<string>((resolve, reject) => {
        let output = "";
        const fail = () => {
          child.stdout?.off("data", data);
          child.stdout?.resume();
          child.off("error", fail);
          child.off("exit", fail);
          reject(new Error("OpenCode v2 startup failed."));
        };
        child.once("error", fail);
        child.once("exit", fail);
        const data = (chunk: Buffer) => {
          output += chunk.toString("utf8");
          if (Buffer.byteLength(output) > 16_384) {
            fail();
            return;
          }
          const newline = output.indexOf("\n");
          if (newline < 0) return;
          child.stdout?.off("data", data);
          child.off("error", fail);
          child.off("exit", fail);
          child.stdout?.resume();
          try {
            const parsed: unknown = JSON.parse(output.slice(0, newline));
            if (
              typeof parsed !== "object" ||
              parsed === null ||
              !("url" in parsed) ||
              typeof parsed.url !== "string"
            )
              throw new Error("Invalid readiness.");
            resolve(validateOwnedEndpoint(parsed.url));
          } catch {
            fail();
          }
        };
        child.stdout?.on("data", data);
      }),
  });
}

export async function startOwnedV2Process(config: V2ProcessConfig): Promise<OwnedV2Process> {
  const env = await isolatedEnvironment(config);
  assertDevelopmentVersion(await executableVersion(config, env));
  let password = randomBytes(32).toString("base64url");
  const child = spawn(config.binaryPath, ["serve", "--stdio", "--hostname=127.0.0.1", "--port=0"], {
    cwd: config.profileRoot,
    env: { ...env, OPENCODE_PASSWORD: password },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  child.stdin.on("error", () => {});
  child.stderr.resume();
  let dead = false;
  let stopping = false;
  let closing: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const notify = () => {
    if (dead) return;
    dead = true;
    if (!stopping)
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          /* One owner must not prevent other loss notifications. */
        }
      }
  };
  child.on("error", notify);
  child.on("exit", notify);
  try {
    const endpoint = await readiness(child);
    const client = makeOwnedClient({ endpoint, password });
    const info = await v2Request("server.info", (signal) => client.server.info({ signal }));
    assertDevelopmentVersion(info.version);
    if (info.pid !== child.pid || dead) throw new Error("OpenCode v2 endpoint ownership rejected.");
    return {
      client,
      isRunning: () => !dead && !stopping,
      hasExited: () => child.exitCode !== null || child.signalCode !== null,
      onDeath: (listener) => {
        listeners.add(listener);
        if (dead && !stopping) listener();
        return () => {
          listeners.delete(listener);
        };
      },
      close: async () => {
        stopping = true;
        listeners.clear();
        password = "";
        closing ??= closeOwnedChild(child);
        await closing;
      },
    };
  } catch {
    stopping = true;
    password = "";
    await closeOwnedChild(child);
    throw new Error(
      "OpenCode v2 isolated startup failed; check the executable and development profile.",
    );
  }
}
