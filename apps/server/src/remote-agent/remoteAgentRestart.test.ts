import { describe, expect, it, vi } from "vitest";
import { makeRemoteAgentRestart } from "./remoteAgentRestart.ts";
import type {
  RemoteAgentRestartRecord,
  RemoteAgentRestartStore,
} from "./remoteAgentRestart.types.ts";
import { joinRestartOperation, makeMemoryStore } from "./remoteAgentRestart.store.ts";
import { emptyRemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";

function runtime(generation: string) {
  const sha = (generation === "g1" ? "a" : "b").repeat(64);
  return {
    generation,
    version: "0.2.207",
    sha256: sha,
    buildDigest: "digest",
    targetTriple: "x86_64-unknown-linux-gnu" as const,
    origin: "managed" as const,
    binaryPath: `/tmp/agent/bin/0.2.207/${sha}/bigbud-remote-agent`,
    statePath: `/tmp/agent/runtimes/${generation}`,
    socketPath: `/tmp/agent/runtimes/${generation}/supervisor.sock`,
    logPath: `/tmp/agent/runtimes/${generation}/supervisor.log`,
  };
}

function store(): RemoteAgentRestartStore {
  const records = new Map<string, RemoteAgentRestartRecord>();
  return {
    get: async (id) => records.get(id),
    put: async (record) => {
      records.set(record.requestId, record);
    },
    update: async (id, transition) => {
      const current = records.get(id);
      if (!current) throw new Error("missing");
      const next = transition(current);
      records.set(id, next);
      return next;
    },
  };
}

describe("remote agent restart coordinator", () => {
  it("performs one replacement and returns the durable result on retry", async () => {
    let bindingReads = 0;
    let stopCommands = 0;
    const verifyReadiness = vi.fn(async () => "g2");
    const registry = emptyRemoteAgentRegistry();
    const control = {
      root: "/tmp/agent",
      run: vi.fn(async (command: string) => {
        if (command.includes("--restart-supervisor")) stopCommands++;
        if (command.includes("launch-reserved")) return "launch-reserved";
        if (command.includes("printf dead")) return "dead";
        if (command.includes("printf ready")) return "ready";
        return "";
      }),
      registry: {
        read: async () => registry,
        update: async (transition: (state: typeof registry) => typeof registry) =>
          transition(registry),
      },
    };
    const restart = makeRemoteAgentRestart({
      close: vi.fn(),
      reconnect: async () => undefined,
      verifySsh: async () => undefined,
      verifyReadiness,
      control: async () => control,
      resolveBinding: async () => {
        bindingReads += 1;
        const value = bindingReads === 1 ? runtime("g1") : runtime("g2");
        return { runtime: value, expectedEpoch: value.generation };
      },
      store: store(),
    });
    const request = {
      requestId: "restart-1",
      projectId: "project-1" as never,
      expectedWorkspaceExecutionTargetId: "ssh:fixture" as never,
    };
    const first = restart.restart(request);
    const result = await first;
    expect(result.phase).toBe("ready");
    expect(verifyReadiness).toHaveBeenCalledOnce();
    expect(stopCommands).toBe(1);
    expect(await restart.restart(request)).toEqual(result);
    expect(stopCommands).toBe(1);
  });

  it("does not stop a service when SSH authentication preflight fails", async () => {
    const close = vi.fn();
    const control = vi.fn();
    const restart = makeRemoteAgentRestart({
      close,
      reconnect: async () => undefined,
      verifySsh: async () => {
        throw new Error("SSH password is required");
      },
      control,
      store: store(),
    });
    await expect(
      restart.restart({
        requestId: "restart-2",
        projectId: "project-2" as never,
        expectedWorkspaceExecutionTargetId: "ssh:fixture" as never,
      }),
    ).rejects.toThrow("password is required");
    expect(control).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("binds a joined request to the canonical durable operation", async () => {
    const durable = makeMemoryStore();
    const canonical = {
      requestId: "restart-canonical",
      projectId: "project-3" as never,
      target: "ssh:fixture",
      runtime: runtime("g1"),
      oldEpoch: "g1",
      phase: "stopping" as const,
      message: "Stopping",
    } satisfies RemoteAgentRestartRecord;
    await durable.put(canonical);
    await joinRestartOperation(
      durable,
      {
        requestId: "restart-alias",
        projectId: "project-3" as never,
        expectedWorkspaceExecutionTargetId: "ssh:fixture" as never,
      },
      {
        requestId: canonical.requestId,
        projectId: canonical.projectId,
        executionTargetId: canonical.target,
        phase: canonical.phase,
        message: canonical.message,
        oldEpoch: canonical.oldEpoch,
      },
      async () => ({ runtime: canonical.runtime, expectedEpoch: canonical.oldEpoch }),
      undefined,
    );
    await durable.update(canonical.requestId, (record) => ({ ...record, phase: "ready" }));

    expect((await durable.get("restart-alias"))?.phase).toBe("ready");
  });
});
