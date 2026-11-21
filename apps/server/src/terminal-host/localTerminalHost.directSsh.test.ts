import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { RemoteAgentOwner, RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import type { PtyAdapterShape, PtyProcess, PtySpawnInput } from "../terminal/Services/PTY.ts";
import { makeLocalTerminalHostPtyAdapter } from "./localTerminalHost.adapter.ts";
import {
  isDirectSshTerminalTarget,
  LOCAL_TERMINAL_HOST_DIRECT_SSH_LIFECYCLE,
  planDirectSshHostLaunch,
} from "./localTerminalHost.directSsh.ts";
import type { LocalTerminalHostController } from "./localTerminalHost.host.ts";
import { LOCAL_TERMINAL_HOST_TARGET_ID } from "./localTerminalHost.paths.ts";

const direct = "ssh:host=devbox&user=me&transport=direct-ssh";
const agent = "ssh:host=devbox&user=me&transport=agent";
const inProcess = { pid: 1234 } as PtyProcess;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function setup(input: { owner?: Partial<RemoteAgentOwner>; admitted?: boolean } = {}) {
  const fallbackCalls: PtySpawnInput[] = [];
  let resolveCalls = 0;
  const fallback: PtyAdapterShape = {
    spawn: (spawnInput) => {
      fallbackCalls.push(spawnInput);
      return Effect.succeed(inProcess);
    },
  };
  const controller = {
    mode: input.admitted ? "enabled" : "adopt-only",
    ready: async () => ({}),
    resolveAdmittedBinding: async () => {
      resolveCalls += 1;
      return undefined;
    },
    currentAdmittedBinding: async () => undefined,
    knownRuntimes: async () => [],
    attachedBindings: async () => [],
    notices: () => [],
  } as unknown as LocalTerminalHostController;
  const owners = {
    get: async () =>
      input.owner
        ? ({ target: LOCAL_TERMINAL_HOST_TARGET_ID, ...input.owner } as RemoteAgentOwner)
        : undefined,
  } as unknown as RemoteAgentOwnerStore;
  const local = makeLocalTerminalHostPtyAdapter({ controller, owners, fallback, stateDir: "/s" });
  cleanups.push(async () => local.close());
  return { local, fallbackCalls, resolveCalls: () => resolveCalls };
}

const sshSpawn = (overrides: Partial<PtySpawnInput> = {}): PtySpawnInput => ({
  shell: "/usr/bin/ssh",
  args: ["-tt", "-o", "BatchMode=yes", "--", "me@devbox", "sh -lc 'exec $SHELL -l'"],
  cwd: "/home/me",
  cols: 80,
  rows: 24,
  env: { PATH: "/usr/bin:/bin", SSH_AUTH_SOCK: "/tmp/agent.sock" },
  executionTargetId: direct,
  ownerKey: JSON.stringify(["thread-1", "ssh"]),
  remoteCwd: "/srv/app",
  ...overrides,
});

describe("Direct SSH targets", () => {
  it("are SSH targets without the remote agent", () => {
    expect(isDirectSshTerminalTarget(direct)).toBe(true);
    expect(isDirectSshTerminalTarget(agent)).toBe(false);
    // Legacy ids follow the process default transport (the agent).
    expect(isDirectSshTerminalTarget("ssh:devbox")).toBe(false);
    expect(isDirectSshTerminalTarget("local")).toBe(false);
    expect(isDirectSshTerminalTarget("wsl:Ubuntu")).toBe(false);
    expect(isDirectSshTerminalTarget(undefined)).toBe(false);
  });

  it("are created owner-hinted and lifecycle-managed with the local environment", () => {
    expect(LOCAL_TERMINAL_HOST_DIRECT_SSH_LIFECYCLE).toEqual({
      lifecycleManaged: true,
      localLaunch: true,
      activitySource: "owner-hint",
    });
  });
});

describe("Direct SSH host launch plan", () => {
  it("keeps the exact ssh command, resolving only the client's absolute path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bb-ssh-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, "ssh"), "#!/bin/sh\n");
    await chmod(join(dir, "ssh"), 0o755);
    const args = ["-tt", "--", "devbox", "sh -lc 'x'"];
    const plan = planDirectSshHostLaunch(
      { shell: "ssh", args, env: { PATH: dir } },
      { home: "/home/me", platform: "linux" },
    );
    expect(plan).toEqual({
      kind: "host",
      command: { shell: join(dir, "ssh"), args },
      cwd: "/home/me",
    });
  });

  it("stays in-process when the host cannot run the launch unchanged", () => {
    const base = { shell: "/usr/bin/ssh", args: [], env: {} };
    expect(planDirectSshHostLaunch(base, { platform: "win32" }).kind).toBe("in-process");
    expect(planDirectSshHostLaunch({ ...base, shell: "/bin/zsh" }).kind).toBe("in-process");
    expect(
      planDirectSshHostLaunch({ ...base, shell: "ssh", env: { PATH: "/nonexistent" } }).kind,
    ).toBe("in-process");
    const huge = Object.fromEntries(
      Array.from({ length: 600 }, (_, index) => [`VAR_${index}`, "x"]),
    );
    expect(planDirectSshHostLaunch({ ...base, env: huge }).kind).toBe("in-process");
  });
});

describe("local terminal host adapter for Direct SSH", () => {
  it("exposes the host runtime, marked as a local ssh client, for Direct SSH targets only", () => {
    const { local } = setup();
    const runtime = local.adapter.ownedRuntimeForTarget?.(direct);
    expect(runtime).toMatchObject({
      targetId: LOCAL_TERMINAL_HOST_TARGET_ID,
      pidNamespace: "backend-host",
    });
    expect(runtime?.localSshClient).toBeDefined();
    expect(runtime?.hostGenerations).toBe(local.runtime.hostGenerations);
    expect(local.adapter.ownedRuntimeForTarget?.("local")?.localSshClient).toBeUndefined();
    expect(local.adapter.ownedRuntimeForTarget?.(agent)).toBeUndefined();
  });

  it("runs ownerless spawns and spawns with no admitted host in-process", async () => {
    const { local, fallbackCalls, resolveCalls } = setup();
    const { ownerKey: _ownerKey, ...ownerless } = sshSpawn();
    await Effect.runPromise(local.adapter.spawn(ownerless));
    expect(resolveCalls()).toBe(0);
    expect(await Effect.runPromise(local.adapter.spawn(sshSpawn()))).toBe(inProcess);
    expect(resolveCalls()).toBe(1);
    expect(fallbackCalls).toHaveLength(2);
  });

  it("never reinterprets a local shell the host still runs for the pane", async () => {
    const shellLaunch = { version: 1 } as unknown as RemoteAgentOwner["shellLaunch"];
    const { local, fallbackCalls } = setup({
      owner: { state: "may-have-been-sent", ...(shellLaunch ? { shellLaunch } : {}) },
    });
    const result = await Effect.runPromise(Effect.result(local.adapter.spawn(sshSpawn())));
    expect(result._tag).toBe("Failure");
    expect(String(result._tag === "Failure" ? result.failure.message : "")).toMatch(
      /local terminal/,
    );
    expect(fallbackCalls).toHaveLength(0);
  });

  it("routes a retained ssh owner to the host, never in-process, even under the kill switch", async () => {
    const { local, fallbackCalls } = setup({ owner: { state: "may-have-been-sent" } });
    // The fake owner is incomplete, so the owned path fails; it must not fall back in-process.
    const result = await Effect.runPromise(Effect.result(local.adapter.spawn(sshSpawn())));
    expect(result._tag).toBe("Failure");
    expect(fallbackCalls).toHaveLength(0);
    const recovered = await Effect.runPromise(
      Effect.result(local.adapter.spawn(sshSpawn({ recoverOnly: true }))),
    );
    expect(recovered._tag).toBe("Failure");
    expect(fallbackCalls).toHaveLength(0);
  });
});
