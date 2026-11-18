import { describe, expect, it } from "vitest";
import type { RemoteAgentLocalProcessInput } from "../remote-agent/remoteAgentConnection.ts";
import type { RemoteAgentRuntimeBinding } from "../remote-agent/remoteAgentConnectionPool.ts";
import { makeLocalSupervisorTransportFactory } from "./localSupervisorTransport.ts";

const targetId = `remote-backend:${"a".repeat(32)}`;
const hash = "b".repeat(64);
const statePath = "/private-agent/runtimes/g1";
const binding: RemoteAgentRuntimeBinding = {
  expectedEpoch: "fixture-epoch",
  runtime: {
    generation: "g1",
    version: "1.0.0",
    sha256: hash,
    buildDigest: "fixture-build",
    targetTriple: "aarch64-unknown-linux-gnu",
    origin: "managed",
    binaryPath: `/private-agent/bin/1.0.0/${hash}/bigbud-remote-agent`,
    statePath,
    socketPath: `${statePath}/supervisor.sock`,
    logPath: `${statePath}/supervisor.log`,
  },
};

describe("local supervisor transport factory", () => {
  it("does not execute a proxy if installed-byte verification fails", async () => {
    let spawned = false;
    const factory = makeLocalSupervisorTransportFactory({
      targetId,
      resolveBinding: async () => binding,
      verifyRuntime: async () => {
        throw new Error("installed bytes changed");
      },
      connect: () => {
        spawned = true;
        throw new Error("unexpected spawn");
      },
    });
    await expect(factory.create(targetId, binding)).rejects.toThrow("installed bytes changed");
    expect(spawned).toBe(false);
  });

  it("opens only the managed proxy with pinned state and a credential-free explicit environment", async () => {
    let input: RemoteAgentLocalProcessInput | undefined;
    const factory = makeLocalSupervisorTransportFactory({
      targetId,
      verifyRuntime: async () => {},
      resolveBinding: async () => binding,
      connect: (value) => {
        input = value;
        throw new Error("captured proxy invocation");
      },
    });
    expect(await factory.resolveBinding!(targetId)).toBe(binding);
    await expect(factory.create(targetId, binding)).rejects.toThrow("captured proxy invocation");
    expect(input).toEqual({
      binaryPath: binding.runtime.binaryPath,
      mode: "proxy",
      env: {
        BIGBUD_AGENT_STATE_DIR: statePath,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
      },
    });
  });

  it("refuses missing epochs, external runtimes and malformed descriptors before any spawn", async () => {
    let called = false;
    const factory = makeLocalSupervisorTransportFactory({
      targetId,
      verifyRuntime: async () => {},
      resolveBinding: async () => binding,
      connect: () => {
        called = true;
        throw new Error("unexpected spawn");
      },
    });
    await expect(factory.create(targetId)).rejects.toThrow("pinned runtime and epoch");
    await expect(factory.create(targetId, { ...binding, expectedEpoch: "" })).rejects.toThrow(
      "pinned runtime and epoch",
    );
    await expect(
      factory.create(targetId, {
        ...binding,
        runtime: { ...binding.runtime, origin: "legacy-external" },
      }),
    ).rejects.toThrow("managed");
    await expect(
      factory.create(targetId, {
        ...binding,
        runtime: { ...binding.runtime, socketPath: "/different/socket" },
      }),
    ).rejects.toThrow("outside its state root");
    expect(called).toBe(false);
  });

  it("cannot resolve or connect SSH aliases or another backend authority", async () => {
    let resolved = false;
    const factory = makeLocalSupervisorTransportFactory({
      targetId,
      resolveBinding: async () => {
        resolved = true;
        return binding;
      },
    });
    for (const other of ["local", "ssh:alias", `remote-backend:${"c".repeat(32)}`]) {
      await expect(factory.resolveBinding!(other)).rejects.toThrow("another authority");
      await expect(factory.create(other, binding)).rejects.toThrow("another authority");
    }
    expect(resolved).toBe(false);
    expect(() =>
      makeLocalSupervisorTransportFactory({
        targetId: "local",
        resolveBinding: async () => binding,
      }),
    ).toThrow("authority identity");
  });
});
