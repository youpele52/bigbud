import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AgentControlOperands,
  AgentControlState,
} from "../ssh/sshOwnerPickerProof.codec.agentControl.ts";
import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import { openOwnerRemoteAgentControl } from "./remoteAgentControl.owner.install.ts";
import { makeRemoteAgentOwnerExec, remoteAgentOwnerOperands } from "./remoteAgentControl.owner.ts";
import { RemoteAgentRemoteCommandError } from "./remoteAgentDiagnostics.ts";

const TARGET = "ssh:host=dev";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Script = (
  operands: AgentControlOperands,
  input: Buffer,
) => { readonly exitCode?: number; readonly stdout?: string; readonly unknown?: boolean };

/** A fake bound target: streamed kinds listen on a real socket; results come from `script`. */
function owner(script: Script, opened: AgentControlOperands[] = []) {
  const target = {
    async openAgentControl(lease: Uint8Array, operands: AgentControlOperands) {
      opened.push(operands);
      const streamed = operands.kind === "registryCas" || operands.kind === "installUpload";
      const settle = (input: Buffer): AgentControlState => {
        const result = script(operands, input);
        return result.unknown
          ? { lease, kind: operands.kind, phase: "outcomeUnknown" }
          : {
              lease,
              kind: operands.kind,
              phase: "exited",
              exitCode: result.exitCode ?? 0,
              stdout: result.stdout ?? "",
              stderr: "boom",
            };
      };
      if (!streamed) {
        state = settle(Buffer.alloc(0));
        return state;
      }
      const dir = mkdtempSync(path.join(tmpdir(), "bb-u25-"));
      dirs.push(dir);
      const socketPath = path.join(dir, "s");
      const chunks: Buffer[] = [];
      const server = createServer((socket) => {
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        socket.on("end", () => {
          state = settle(Buffer.concat(chunks));
          server.close();
        });
      });
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      state = { lease, kind: operands.kind, phase: "listening", socketPath };
      return state;
    },
    agentControlStatus: async () => state,
    cancelAgentControl: async () => state,
  };
  let state: AgentControlState;
  const registration = {
    descriptorFor: async () => ({}),
    handle: { target: () => target },
  } as unknown as SshOwnerProductionRegistration;
  return { owner: () => registration, pollMs: { first: 1, max: 5 } };
}

describe("U25 production remote-agent control", () => {
  it("maps every operation to data operands only", () => {
    const cas = remoteAgentOwnerOperands({ kind: "registryCas", expected: "{}", next: '{"a":1}' });
    expect(cas.operands).toEqual({
      kind: "registryCas",
      expected: { size: 2, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      next: { size: 7, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(Buffer.from(cas.input!).toString()).toBe('{}{"a":1}');
    expect(remoteAgentOwnerOperands({ kind: "runtimeProbe", binaryPath: null }).operands).toEqual({
      kind: "runtimeProbe",
    });
  });

  it("opens the control root and streams a registry CAS on the lease socket", async () => {
    const opened: AgentControlOperands[] = [];
    let received = "";
    const dependencies = owner((operands, input) => {
      if (operands.kind === "controlRoot") return { stdout: "/home/dev/.bigbud/agent" };
      if (operands.kind === "registryRead") return { stdout: "clock=5\nmissing" };
      received = input.toString();
      return { stdout: "committed" };
    }, opened);
    const control = await openOwnerRemoteAgentControl(dependencies, TARGET);
    expect(control.root).toBe("/home/dev/.bigbud/agent");
    await expect(control.run("echo hi")).rejects.toThrow(/typed remote agent operations/);
    const state = await control.registry.update((current) => ({
      ...current,
      revision: current.revision + 1,
    }));
    expect(state.revision).toBe(1);
    expect(JSON.parse(received).revision).toBe(1);
    expect(opened.map(({ kind }) => kind)).toEqual(["controlRoot", "registryRead", "registryCas"]);
  });

  it("keeps the legacy diagnosed-command errors and never replays an unknown outcome", async () => {
    let calls = 0;
    const failing = makeRemoteAgentOwnerExec(
      owner(() => ({ exitCode: 78 })),
      TARGET,
    );
    await expect(failing({ kind: "inventory" })).rejects.toMatchObject({
      exitCode: 78,
      stage: "control",
    });
    const unknown = makeRemoteAgentOwnerExec(
      owner(() => {
        calls += 1;
        return { unknown: true };
      }),
      TARGET,
    );
    const error = await unknown({ kind: "removalResume" }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RemoteAgentRemoteCommandError);
    expect((error as RemoteAgentRemoteCommandError).timedOut).toBe(true);
    expect(calls).toBe(1);
  });

  it("refuses before any dispatch when no owner is running", async () => {
    const exec = makeRemoteAgentOwnerExec({ owner: () => undefined }, TARGET);
    await expect(exec({ kind: "hostClock" })).rejects.toThrow(/not running/);
  });
});
