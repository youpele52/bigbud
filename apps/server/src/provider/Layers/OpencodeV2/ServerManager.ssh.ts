import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { buildSshCommandInvocation, buildSshTransportArgs } from "../../../ssh/sshCommand.ts";
import { parseSshExecutionTarget, formatSshDestination } from "../../../ssh/sshExecutionTarget.ts";
import { makeOwnedClient, v2Request } from "./Client.ts";
import { assertDevelopmentVersion } from "./Compatibility.ts";
import {
  closeOwnedChild,
  type V2ProcessConfig,
  type OwnedV2Process,
} from "./ServerManager.child.ts";
import { observeV2SshBootstrap } from "./ServerManager.ssh.protocol.ts";
import { renderV2CodingPlugin } from "./Coding.plugin.ts";
import { renderV2LegacyCodingPlugin } from "./Coding.plugin.legacy.ts";
import { renderV2PreviousCodingPlugin } from "./Coding.plugin.previous.ts";
import { V2UnconfirmedProcessStartup } from "./ServerManager.lifecycle.ts";

export async function v2SshBootstrapInvocation(targetId: string) {
  const target = parseSshExecutionTarget(targetId);
  if (!target || target.authMode !== "ssh-key")
    throw new Error("V2 protected SSH bootstrap requires verified key transport.");
  const program = await v2SshBootstrapProgram();
  return buildSshCommandInvocation({
    executionTargetId: targetId,
    command: "node",
    args: ["--input-type=module", "-e", program],
    transportArgs: ["-o", "StrictHostKeyChecking=yes"],
  });
}

/** Embed the shared isolation policy in the fixed remote program, without remote module lookup. */
export async function v2SshBootstrapProgram(): Promise<string> {
  const script = await readFile(
    new URL("./ServerManager.ssh.bootstrap.mjs", import.meta.url),
    "utf8",
  );
  const isolation = await readFile(new URL("./ProfileIsolation.mjs", import.meta.url), "utf8");
  const windows = await readFile(
    new URL("./ProfileIsolation.windows.mjs", import.meta.url),
    "utf8",
  );
  const program =
    windows
      .replace(/^import .*from "node:child_process";$/m, "")
      .replace('import path from "node:path";', "")
      .replaceAll("export ", "") +
    "\n" +
    isolation
      .replace(/^import .*from "\.\/ProfileIsolation\.windows\.mjs";$/m, "")
      .replace(
        "export async function inspectPrivateV2Profile",
        "async function inspectPrivateV2Profile",
      ) +
    "\n" +
    script
      .replace('import { inspectPrivateV2Profile } from "./ProfileIsolation.mjs";', "")
      .replace('import path from "node:path";', "");
  return program;
}

async function localPort(): Promise<number> {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("V2 tunnel port unavailable."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

/** Real protected-stdin bootstrap + loopback tunnel, gated until host/platform conformance is supplied. */
export async function startOwnedV2SshProcess(
  config: V2ProcessConfig,
  gate: { readonly protectedBootstrapConformance: boolean; readonly spawn?: typeof spawn },
): Promise<OwnedV2Process> {
  if (!gate.protectedBootstrapConformance)
    throw new Error("V2 protected SSH bootstrap conformance is unavailable.");
  const invocation = await v2SshBootstrapInvocation(config.runtimeTargetId);
  const target = parseSshExecutionTarget(config.runtimeTargetId)!;
  const password = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const spawnChild = gate.spawn ?? spawn;
  const codingPort = config.codingEndpoint ? await localPort() : undefined;
  const bootstrap = spawnChild(invocation.command, [...invocation.args], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  bootstrap.stderr!.resume();
  bootstrap.stdin!.on("error", () => {});
  let tunnel: ChildProcess | undefined;
  let stopping = false;
  let dead = false;
  let closing: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  let localSpawned = false;
  let neverSpawned: Error | undefined;
  bootstrap.once("spawn", () => {
    localSpawned = true;
  });
  bootstrap.once("error", (error: NodeJS.ErrnoException) => {
    if (
      !localSpawned &&
      bootstrap.pid === undefined &&
      (error.code === "ENOENT" || error.code === "EACCES")
    )
      neverSpawned = error;
  });
  const notify = () => {
    if (dead || stopping) return;
    dead = true;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* isolate owners */
      }
    }
  };
  bootstrap.on("error", notify);
  bootstrap.on("exit", notify);
  const observation = observeV2SshBootstrap(bootstrap, nonce);
  let client = makeOwnedClient({ endpoint: "http://127.0.0.1:1", password });
  const owned: OwnedV2Process = {
    get client() {
      return client;
    },
    isRunning: () => !dead && !stopping && !observation.hasExited(),
    hasExited: observation.hasExited,
    onDeath: observation.onExit,
    onUnavailable: (listener) => {
      listeners.add(listener);
      if (dead) listener();
      return () => {
        listeners.delete(listener);
      };
    },
    close: async () => {
      stopping = true;
      if (neverSpawned) return;
      closing ??= Promise.all([
        closeOwnedChild(bootstrap),
        ...(tunnel ? [closeOwnedChild(tunnel)] : []),
      ]).then(() => {});
      await closing;
      if (!observation.hasExited())
        throw new Error("V2 SSH close remains unconfirmed; native exit receipt absent.");
    },
  };
  try {
    bootstrap.stdin!.write(
      JSON.stringify({
        binaryPath: config.binaryPath,
        profileRoot: config.profileRoot,
        password,
        nonce,
        application: true,
        workspaceRoot: config.workspaceRoot,
        ...(config.codingEndpoint && codingPort
          ? {
              pluginSource: renderV2CodingPlugin(
                `http://127.0.0.1:${codingPort}/invoke`,
                config.codingEndpoint.token,
              ),
              previousPluginSource: renderV2LegacyCodingPlugin(
                `http://127.0.0.1:${codingPort}/invoke`,
                config.codingEndpoint.token,
              ),
              previousNativePluginSource: renderV2PreviousCodingPlugin(
                `http://127.0.0.1:${codingPort}/invoke`,
                config.codingEndpoint.token,
              ),
            }
          : {}),
      }) + "\n",
    );
    const ready = await observation.ready;
    const port = await localPort();
    tunnel = spawnChild(
      "ssh",
      [
        ...buildSshTransportArgs({ executionTargetId: config.runtimeTargetId }),
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ExitOnForwardFailure=yes",
        "-N",
        "-L",
        `127.0.0.1:${port}:127.0.0.1:${new URL(ready.url).port}`,
        ...(config.codingEndpoint && codingPort
          ? ["-R", `127.0.0.1:${codingPort}:127.0.0.1:${new URL(config.codingEndpoint.url).port}`]
          : []),
        formatSshDestination(target),
      ],
      { stdio: ["pipe", "ignore", "pipe"], shell: false },
    );
    tunnel.stderr!.resume();
    tunnel.stdin!.on("error", () => {});
    tunnel.on("error", notify);
    tunnel.on("exit", notify);
    client = makeOwnedClient({ endpoint: `http://127.0.0.1:${port}`, password });
    let verified = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (dead) break;
      try {
        const info = await v2Request(
          "SSH server.info",
          (signal) => client.server.info({ signal }),
          { timeoutMs: 1000 },
        );
        assertDevelopmentVersion(info.version);
        if (info.pid !== ready.pid) throw new Error("V2 SSH endpoint PID mismatch.");
        verified = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!verified || dead) throw new Error("V2 SSH endpoint ownership unconfirmed.");
    return owned;
  } catch (cause) {
    await owned.close().catch(() => {});
    if (neverSpawned)
      throw new Error("V2 local SSH executable never started; no remote dispatch.", {
        cause,
      });
    if (!observation.hasExited()) throw new V2UnconfirmedProcessStartup(owned, cause);
    throw new Error("V2 protected SSH runtime failed after confirmed native exit.", { cause });
  }
}
