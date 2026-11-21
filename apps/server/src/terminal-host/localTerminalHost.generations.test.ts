import { describe, expect, it } from "vitest";

import type { RemoteAgentRuntimeBinding } from "../remote-agent/remoteAgentConnectionPool.ts";
import type { RemoteAgentFrame } from "../remote-agent/remoteAgentProtocol.ts";
import type { RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import { terminalHostPolicy } from "../terminal/Layers/Manager.hostPolicy.ts";
import type { LocalTerminalHostDrainingNotice } from "./localTerminalHost.adopt.ts";
import { makeLocalTerminalHostGenerations } from "./localTerminalHost.generations.ts";
import type { LocalTerminalHostController } from "./localTerminalHost.host.ts";

const binding = (generation: number): RemoteAgentRuntimeBinding => ({
  connectionId: `state-${generation}`,
  runtime: { generation: `state-${generation}` } as RemoteAgentRuntime,
  expectedEpoch: `epoch-${generation}`,
});

/** One lifecycle-capable host connection that answers close-all and policy requests. */
function connection(closed: number, requests: string[]) {
  return {
    supportsCapability: () => true,
    onFrame: () => () => undefined,
    request: async (frame: RemoteAgentFrame) => {
      requests.push(frame.type);
      const requestId = (frame.value as { requestId: string }).requestId;
      if (frame.type === "ptyCloseAllRequest")
        return {
          type: "ptyCloseAllResponse",
          value: {
            requestId,
            accepted: true,
            errorCode: "",
            errorMessage: "",
            closedCount: closed,
          },
        };
      return {
        type: "hostPolicyUpdateResponse",
        value: {
          requestId,
          accepted: true,
          errorCode: "",
          errorMessage: "",
          effective: terminalHostPolicy({ keepRunningAfterQuit: false, revision: 1 }),
        },
      };
    },
  };
}

function setup(notices: LocalTerminalHostDrainingNotice[] = []) {
  const requests = new Map<string, string[]>([
    ["state-1", []],
    ["state-2", []],
  ]);
  const closed: number[] = [];
  let current = notices;
  const controller = {
    ready: async () => ({}) as never,
    attachedBindings: async () => [
      { generation: 1, binding: binding(1), admitted: false },
      { generation: 2, binding: binding(2), admitted: true },
      { generation: 3, binding: binding(3), admitted: false },
    ],
    currentAdmittedBinding: async () => binding(2),
    notices: () => current,
    closeDrainingHost: async (generation: number) => {
      closed.push(generation);
      current = current.filter((notice) => notice.generation !== generation);
    },
  } as unknown as LocalTerminalHostController;
  const pool = {
    getBound: async (_target: string, entry: RemoteAgentRuntimeBinding) => {
      const log = requests.get(entry.connectionId!);
      // Generation 3 is a draining host that no longer answers.
      if (!log) throw new Error("unreachable");
      return connection(entry.connectionId === "state-1" ? 3 : 2, log) as never;
    },
  };
  return { generations: makeLocalTerminalHostGenerations({ controller, pool }), requests, closed };
}

describe("local terminal host generations", () => {
  it("closes managed terminals on every reachable generation, draining ones included", async () => {
    const { generations, requests } = setup();
    expect(await generations.closeAll({ reason: "quit", managedOnly: true })).toEqual({
      closed: 5,
      unreachable: 1,
    });
    expect(requests.get("state-1")).toEqual(["ptyCloseAllRequest"]);
    expect(requests.get("state-2")).toEqual(["ptyCloseAllRequest"]);
  });

  it("pushes the policy to every reachable generation and keys the admitted one", async () => {
    const { generations, requests } = setup();
    await generations.updatePolicy(terminalHostPolicy({ keepRunningAfterQuit: true, revision: 9 }));
    expect(requests.get("state-1")).toEqual(["hostPolicyUpdateRequest"]);
    expect(requests.get("state-2")).toEqual(["hostPolicyUpdateRequest"]);
    expect(await generations.admittedKey()).toBe("state-2:epoch-2");
  });

  it("closes only old hosts whose process identity is verified", async () => {
    const { generations, closed } = setup([
      { generation: 4, reason: "unreachable", firstTime: true, canClose: true },
      { generation: 5, reason: "incompatible", firstTime: true, canClose: false },
    ]);
    expect(await generations.closeDrainingHosts()).toEqual({ closed: 1, remaining: 1 });
    expect(closed).toEqual([4]);
    expect(generations.drainingNotices().map((notice) => notice.generation)).toEqual([5]);
  });
});
