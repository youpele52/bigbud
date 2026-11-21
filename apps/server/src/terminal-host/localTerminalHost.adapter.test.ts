import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { RemoteAgentOwner, RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import type { PtyAdapterShape, PtyProcess, PtySpawnInput } from "../terminal/Services/PTY.ts";
import { makeLocalTerminalHostPtyAdapter } from "./localTerminalHost.adapter.ts";
import type { LocalTerminalHostController } from "./localTerminalHost.host.ts";
import { LOCAL_TERMINAL_HOST_TARGET_ID } from "./localTerminalHost.paths.ts";

const inProcess = { pid: 1234 } as PtyProcess;

function setup(input: { owner?: Partial<RemoteAgentOwner>; admitted?: boolean } = {}) {
  const fallbackCalls: Array<PtySpawnInput> = [];
  const logs: Array<string> = [];
  let resolveCalls = 0;
  const fallback: PtyAdapterShape = {
    spawn: (spawnInput) => {
      fallbackCalls.push(spawnInput);
      return Effect.succeed(inProcess);
    },
  };
  const controller: LocalTerminalHostController = {
    mode: input.admitted ? "enabled" : "adopt-only",
    ready: async () => ({
      admitted: undefined,
      attached: [],
      notices: [],
      highestGeneration: 0,
      socketPathTooLong: false,
    }),
    resolveAdmittedBinding: async () => {
      resolveCalls += 1;
      return undefined;
    },
    currentAdmittedBinding: async () => undefined,
    knownRuntimes: async () => [],
    proxyBinary: async () => "/staged/agent",
    notices: () => [],
    closeDrainingHost: async () => {},
  };
  const owners = {
    get: async () =>
      input.owner
        ? ({ target: LOCAL_TERMINAL_HOST_TARGET_ID, ...input.owner } as RemoteAgentOwner)
        : undefined,
  } as unknown as RemoteAgentOwnerStore;
  const local = makeLocalTerminalHostPtyAdapter({
    controller,
    owners,
    fallback,
    stateDir: "/state",
    log: (message) => logs.push(message),
  });
  return { local, fallbackCalls, logs, resolveCalls: () => resolveCalls };
}

const spawnInput = (overrides: Partial<PtySpawnInput> = {}): PtySpawnInput => ({
  shell: "/bin/zsh",
  cwd: "/tmp",
  cols: 80,
  rows: 24,
  env: {},
  executionTargetId: "local",
  ownerKey: JSON.stringify(["thread-1", "default"]),
  ...overrides,
});

describe("local terminal host PTY adapter", () => {
  it("exposes a backend-host owned runtime for local panes only", () => {
    const { local } = setup();
    expect(local.adapter.ownedRuntimeForTarget?.("local")).toMatchObject({
      targetId: LOCAL_TERMINAL_HOST_TARGET_ID,
      pidNamespace: "backend-host",
    });
    expect(local.adapter.ownedRuntimeForTarget?.("ssh:example")).toBeUndefined();
    local.close();
  });

  it("keeps non-local targets and ownerless spawns in-process", async () => {
    const { local, fallbackCalls, resolveCalls } = setup();
    await Effect.runPromise(local.adapter.spawn(spawnInput({ executionTargetId: "ssh:example" })));
    const { ownerKey: _ownerKey, ...ownerless } = spawnInput();
    await Effect.runPromise(local.adapter.spawn(ownerless));
    expect(fallbackCalls).toHaveLength(2);
    expect(resolveCalls()).toBe(0);
    local.close();
  });

  it("runs new terminals in-process when no host is admitted (kill switch or launch failure)", async () => {
    const { local, fallbackCalls, resolveCalls } = setup();
    const process = await Effect.runPromise(local.adapter.spawn(spawnInput()));
    expect(process).toBe(inProcess);
    expect(fallbackCalls).toHaveLength(1);
    expect(resolveCalls()).toBe(1);
    local.close();
  });

  it("host-wide controls address only a running host and never launch one", async () => {
    const { local, resolveCalls } = setup({ admitted: true });
    const host = local.adapter.ownedRuntimeForTarget?.("local")?.host;
    expect(host).toBeDefined();
    await expect(host!.capabilities()).rejects.toMatchObject({ code: "HOST_UNAVAILABLE" });
    expect(resolveCalls()).toBe(0);
    local.close();
  });

  it("keeps a terminal in-process when its hook environment is not under the state directory", async () => {
    const { local, fallbackCalls, logs, resolveCalls } = setup({ admitted: true });
    const env = { BIGBUD_SHELL_INTEGRATION_DIR: "/tmp/elsewhere/abc" };
    await Effect.runPromise(local.adapter.spawn(spawnInput({ env })));
    expect(fallbackCalls).toHaveLength(1);
    // Decided before any host binding is resolved, so no host is launched for it.
    expect(resolveCalls()).toBe(0);
    expect(logs).toHaveLength(1);
    local.close();
  });

  it("routes a retained host owner to the host even under the kill switch", async () => {
    const { local, fallbackCalls } = setup({ owner: { state: "may-have-been-sent" } });
    // The fake owner is incomplete, so the owned path fails; it must not fall back in-process.
    const result = await Effect.runPromise(Effect.result(local.adapter.spawn(spawnInput())));
    expect(result._tag).toBe("Failure");
    expect(fallbackCalls).toHaveLength(0);
    local.close();
  });
});
