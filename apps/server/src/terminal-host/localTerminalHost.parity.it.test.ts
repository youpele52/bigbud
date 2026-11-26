import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import type { PtyAdapterShape, PtyProcess, PtySpawnInput } from "../terminal/Services/PTY.ts";
import { makeLocalTerminalHostPtyAdapter } from "./localTerminalHost.adapter.ts";
import { localTerminalHostLaunchEnvironment } from "./localTerminalHost.launchSpec.ts";
import { localTerminalHostPaths } from "./localTerminalHost.paths.ts";
import {
  SHELL_MANAGED_NAMES,
  captureLoginEnvironment,
  differingNames,
  integrationMarkers,
  managerSpawnEnvironment,
  nodePtyAdapter,
  readEnvFile,
  makeTerminalHostOwnerStore,
  realLocalTerminalHostController,
  recordPty,
  runCommand,
} from "./localTerminalHost.parity.testUtils.ts";
import { makeLocalTerminalHostProcesses } from "./localTerminalHost.process.ts";
import { makeLocalTerminalHostRegistry } from "./localTerminalHost.registry.ts";
import { makeShortTerminalHostRoot } from "./localTerminalHost.testUtils.ts";

const enabled = process.env.BIGBUD_TERMINAL_HOST_IT === "1" && process.platform !== "win32";
const processes = makeLocalTerminalHostProcesses();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const noFallback: PtyAdapterShape = {
  spawn: () => Effect.die(new Error("A parity terminal must not fall back in-process.")),
};

/** One backend: a real controller, the SQLite owner store and the local host adapter. */
function backend(stateDir: string, owners: RemoteAgentOwnerStore) {
  const controller = realLocalTerminalHostController(localTerminalHostPaths(stateDir), processes);
  const local = makeLocalTerminalHostPtyAdapter({
    controller,
    owners,
    fallback: noFallback,
    stateDir,
  });
  cleanups.push(() => local.close());
  return local;
}

async function ownerStore(stateDir: string) {
  const owners = await makeTerminalHostOwnerStore(stateDir);
  cleanups.push(owners.dispose);
  return owners.store;
}

async function stateRoot() {
  const root = await makeShortTerminalHostRoot();
  cleanups.push(root.cleanup);
  cleanups.push(async () => {
    for (const record of await makeLocalTerminalHostRegistry(root.paths).read()) {
      if (record.pid === undefined) continue;
      processes.signal(record.pid, "SIGTERM");
      await processes.waitForExit(record.pid, 3_000);
    }
  });
  const cwd = join(root.stateDir, "work");
  await mkdir(cwd);
  return { ...root, cwd };
}

function track(process: PtyProcess) {
  const recorder = recordPty(process);
  cleanups.push(() => {
    recorder.dispose();
    try {
      process.kill();
    } catch {
      // Already gone.
    }
  });
  return recorder;
}

const spawn = (adapter: PtyAdapterShape, input: PtySpawnInput) =>
  Effect.runPromise(adapter.spawn(input));

describe.skipIf(!enabled)("S6 local launch parity with the real binary", () => {
  it("a real login environment reaches the host shell entry for entry, as with node-pty", async () => {
    const root = await stateRoot();
    const login = captureLoginEnvironment();
    // The plan's fixture: a real environment over the remote 64-entry cap, with a lowercase name.
    if (!Object.keys(login).some((name) => /[a-z]/.test(name)))
      login.http_proxy = "http://proxy.invalid:3128";
    const env = await managerSpawnEnvironment(login, root.stateDir);
    const requested = localTerminalHostLaunchEnvironment(env, root.cwd);
    expect(Object.keys(login).length).toBeGreaterThan(64);
    expect(requested.length).toBe(Object.keys(env).length);
    expect(requested.some((entry) => /[a-z]/.test(entry.name))).toBe(true);

    const base = { shell: "/bin/sh", args: [], cwd: root.cwd, cols: 120, rows: 40, env };
    const nodeProcess = await spawn(await nodePtyAdapter(), base);
    const nodeOutput = track(nodeProcess);
    const local = backend(root.stateDir, await ownerStore(root.stateDir));
    const hostProcess = await spawn(local.adapter, {
      ...base,
      executionTargetId: "local",
      ownerKey: JSON.stringify(["thread-parity", "env"]),
    });
    const hostOutput = track(hostProcess);
    expect(hostProcess.pidDomain).toBe("remote");

    const nodeFile = join(root.stateDir, "node.env");
    const hostFile = join(root.stateDir, "host.env");
    await runCommand(nodeProcess, nodeOutput, `/usr/bin/env -0 > ${nodeFile}`, "NODE");
    await runCommand(hostProcess, hostOutput, `/usr/bin/env -0 > ${hostFile}`, "HOST");
    const nodeEnv = await readEnvFile(nodeFile);
    const hostEnv = await readEnvFile(hostFile);

    // Entry for entry: identical inside both shells (names only are reported on failure).
    expect(differingNames(hostEnv, nodeEnv)).toEqual([]);
    // Every requested entry arrives unchanged, apart from variables the shell maintains itself.
    const requestedMap = Object.fromEntries(requested.map((entry) => [entry.name, entry.value]));
    const visible = Object.fromEntries(
      Object.keys(requestedMap).map((name) => [name, hostEnv[name]]),
    );
    expect(differingNames(visible, requestedMap, SHELL_MANAGED_NAMES)).toEqual([]);
    expect(hostEnv.PATH).toBe(env.PATH);
    expect(hostEnv.SHELL).toBe(env.SHELL);
  }, 120_000);

  it("PATH, SHELL, integration markers and hook environment match in the user's zsh", async () => {
    const root = await stateRoot();
    const env = await managerSpawnEnvironment(captureLoginEnvironment(), root.stateDir);
    const base = {
      shell: "/bin/zsh",
      args: ["-o", "nopromptsp"],
      cwd: root.cwd,
      cols: 120,
      rows: 40,
      env,
    };
    const nodeProcess = await spawn(await nodePtyAdapter(), base);
    const local = backend(root.stateDir, await ownerStore(root.stateDir));
    const hostProcess = await spawn(local.adapter, {
      ...base,
      executionTargetId: "local",
      ownerKey: JSON.stringify(["thread-parity", "zsh"]),
    });
    const sessions = [
      { name: "NODE", process: nodeProcess, recorder: track(nodeProcess) },
      { name: "HOST", process: hostProcess, recorder: track(hostProcess) },
    ];
    const results = [];
    const file = join(root.cwd, "zsh.env");
    for (const session of sessions) {
      // The same command line in both shells, so their command markers can be compared exactly.
      const { start } = await runCommand(
        session.process,
        session.recorder,
        "/usr/bin/env -0 > zsh.env",
        "ZSH_ENV",
      );
      // The end marker comes from the next prompt's precmd.
      await session.recorder.waitFor("\u001b]133;D;", start);
      results.push({
        env: await readEnvFile(file),
        markers: integrationMarkers(session.recorder.output().slice(start)),
      });
      await rm(file);
    }
    const [node, host] = results as [(typeof results)[0], (typeof results)[0]];
    const watched = [
      "PATH",
      "SHELL",
      "PWD",
      "BIGBUD_SHELL_INTEGRATION_DIR",
      "BIGBUD_CLAUDE_HOOKS",
      "BIGBUD_CODEX_NOTIFY",
      "BIGBUD_TERMINAL_AGENT_HOOKS",
      "BIGBUD_FISH_DATA_DIR",
      "XDG_DATA_DIRS",
      "ZDOTDIR",
      "TERM",
      "TERM_PROGRAM",
    ];
    const pick = (source: Record<string, string>) =>
      Object.fromEntries(watched.map((name) => [name, source[name]]));
    expect(differingNames(pick(host.env), pick(node.env))).toEqual([]);
    expect(host.env.BIGBUD_CLAUDE_HOOKS?.startsWith(join(root.stateDir, "shell-integration"))).toBe(
      true,
    );
    // Same OSC 133 command markers (and any OSC 7 cwd reports the user's config emits).
    expect(host.markers).toEqual(node.markers);
    expect(host.markers.some((marker) => marker.startsWith("133;C;cmdline_url="))).toBe(true);
    expect(host.markers).toContain("133;D;0");
  }, 120_000);

  it("a hook event from an adopted terminal still arrives after a backend restart", async () => {
    const root = await stateRoot();
    const env = await managerSpawnEnvironment(captureLoginEnvironment(), root.stateDir);
    const owners = await ownerStore(root.stateDir);
    const ownerKey = JSON.stringify(["thread-parity", "hooks"]);
    const base = {
      shell: "/bin/zsh",
      args: ["-o", "nopromptsp"],
      cwd: root.cwd,
      cols: 120,
      rows: 40,
    };
    const first = backend(root.stateDir, owners);
    const original = await spawn(first.adapter, {
      ...base,
      env,
      executionTargetId: "local",
      ownerKey,
    });
    const originalOutput = recordPty(original);
    await runCommand(original, originalOutput, "true", "FIRST");
    // Backend exit: the observer detaches, the transport closes, the host keeps the shell.
    originalOutput.dispose();
    original.detach?.();
    first.close();

    // A new backend reinstalls the integration at the same path and adopts the same host.
    await managerSpawnEnvironment(captureLoginEnvironment(), root.stateDir);
    const second = backend(root.stateDir, owners);
    const adopted = await spawn(second.adapter, {
      ...base,
      env: {},
      executionTargetId: "local",
      ownerKey,
      recoverOnly: true,
    });
    const adoptedOutput = track(adopted);
    expect(adopted.recovered).toBe(true);
    const { start } = await runCommand(
      adopted,
      adoptedOutput,
      'sh "$BIGBUD_SHELL_INTEGRATION_DIR/codex-notify.sh"; test -r "$BIGBUD_CLAUDE_HOOKS" && printf \'BBTH_%s\\n\' HOOKS_READABLE',
      "HOOK",
    );
    const output = adoptedOutput.output().slice(start);
    expect(output).toContain("\u001b]777;bigbud;done\u0007");
    expect(output).toContain("BBTH_HOOKS_READABLE");
    // Still one host generation: the adopted terminal never moved.
    const records = await makeLocalTerminalHostRegistry(root.paths).read();
    expect(records.map((record) => record.generation)).toEqual([1]);
  }, 120_000);
});
