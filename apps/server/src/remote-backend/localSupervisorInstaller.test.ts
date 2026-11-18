import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalizeRemoteAgentArtifact,
  type RemoteAgentArtifact,
} from "../remote-agent/remoteAgentArtifact.ts";
import {
  emptyRemoteAgentRegistry,
  parseRemoteAgentRegistry,
} from "../remote-agent/remoteAgentInstall.registry.ts";
import { pinRemoteAgentBuild } from "../remote-agent/remoteAgentInstall.registry.transitions.ts";
import type { RemoteAgentControl } from "../remote-agent/remoteAgentControl.ts";
import type { LocalSupervisorControl } from "./localSupervisorControl.ts";
import { makeLocalSupervisorInstaller } from "./localSupervisorInstaller.ts";
import { runSshCommand } from "../ssh/sshProcess.ts";
import { remoteAgentBuildId, type RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";

vi.mock("../ssh/sshProcess.ts", () => ({
  runSshCommand: vi.fn(() => {
    throw new Error("Unexpected SSH execution");
  }),
}));

function fixture() {
  const targetId = `remote-backend:${"a".repeat(32)}`;
  const homeDir = "/private-local-home";
  const root = `${homeDir}/.bigbud/agent`;
  const bytes = new Uint8Array([1, 2, 3]);
  const keys = generateKeyPairSync("ed25519");
  const unsigned: RemoteAgentArtifact = {
    version: "0.2.207",
    buildDigest: "signed-local-fixture",
    protocolMajor: 1,
    protocolMinor: 2,
    targetTriple: "aarch64-unknown-linux-gnu",
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bundledPath: "/fixture/agent",
    signature: { algorithm: "ed25519", keyId: "fixture", value: "pending" },
  };
  const artifact: RemoteAgentArtifact = {
    ...unsigned,
    signature: {
      ...unsigned.signature,
      value: sign(
        null,
        Buffer.from(canonicalizeRemoteAgentArtifact(unsigned)),
        keys.privateKey,
      ).toString("base64"),
    },
  };
  const source = {
    manifest: { schemaVersion: 1 as const, artifacts: [artifact] },
    trustStore: { fixture: keys.publicKey.export({ type: "spki", format: "pem" }).toString() },
  };
  let state = emptyRemoteAgentRegistry();
  let installed = false;
  const registry = {
    read: async () => state,
    update: async (transition: Parameters<RemoteAgentControl["registry"]["update"]>[0]) => {
      const next = transition(state);
      if (next !== state) expect(next.revision).toBe(state.revision + 1);
      state = parseRemoteAgentRegistry(JSON.stringify(next));
      return state;
    },
  };
  const run = vi.fn(async (_target: string, script: string, options?: { stdin?: string }) => {
    let stdout = "";
    if (script.includes("uname -s")) stdout = "Linux\naarch64\n";
    else if (script.includes("verified_file()")) stdout = installed ? "managed" : "absent";
    else if (script.includes("base64 --decode")) {
      expect(options?.stdin).toBe(Buffer.from(bytes).toString("base64"));
      installed = true;
    } else if (script.includes("--check"))
      stdout = "bigbud-remote-agent 0.2.207 1 2 signed-local-fixture linux aarch64";
    return { stdout, stderr: "", code: 0, signal: null, timedOut: false };
  });
  const remoteControl: RemoteAgentControl = {
    root,
    registry,
    run: async (script) => (await run(targetId, script)).stdout,
  };
  const control: LocalSupervisorControl = {
    targetId,
    homeDir,
    root,
    run,
    openControl: vi.fn(async (target) => {
      expect(target).toBe(targetId);
      return remoteControl;
    }),
  };
  const readArtifactBytes = vi.fn(async () => bytes);
  const installer = makeLocalSupervisorInstaller({ control, readArtifactBytes });
  return {
    installer,
    control,
    registry,
    targetId,
    source,
    artifact,
    bytes,
    run,
    readArtifactBytes,
    replace: (next: typeof state) => {
      state = parseRemoteAgentRegistry(JSON.stringify(next));
    },
  };
}

describe("signed local supervisor installer", () => {
  it("rejects another target and the development bypass before any command", async () => {
    const f = fixture();
    expect(() =>
      f.installer.install({ executionTargetId: "ssh:fixture", source: f.source }),
    ).toThrow("another authority");
    expect(() =>
      f.installer.install({
        executionTargetId: f.targetId,
        source: { ...f.source, allowUntrustedDevelopmentArtifact: true },
      }),
    ).toThrow("signed trusted");
    expect(f.run).not.toHaveBeenCalled();
  });

  it("rejects untrusted signatures before downloading, installing or executing artifact bytes", async () => {
    const f = fixture();
    await expect(
      f.installer.install({
        executionTargetId: f.targetId,
        source: { ...f.source, trustStore: {} },
      }),
    ).rejects.toThrow();
    expect(f.readArtifactBytes).not.toHaveBeenCalled();
    expect(f.run.mock.calls.every(([, script]) => script.includes("uname -s"))).toBe(true);
  });

  it("rejects changed signed payload before creating a stage or executing it", async () => {
    const f = fixture();
    f.readArtifactBytes.mockResolvedValue(new Uint8Array([9, 9, 9]));
    await expect(
      f.installer.install({ executionTargetId: f.targetId, source: f.source }),
    ).rejects.toThrow();
    expect((await f.registry.read()).stages).toEqual([]);
    expect(f.run.mock.calls.some(([, script]) => script.includes("--check"))).toBe(false);
  });

  it("fences admission before consulting another authority's retained bindings or preparation", async () => {
    const f = fixture();
    const getBinding = vi.fn();
    const prepare = vi.fn();
    const admission = f.installer.createAdmission({ getBinding, bindConnection: vi.fn() }, vi.fn());
    await expect(admission.resolveBinding("ssh:fixture")).rejects.toThrow("another authority");
    expect(() => admission.fresh("ssh:fixture", "request", prepare)).toThrow("another authority");
    expect(getBinding).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it("returns no selection without running the legacy executable probe when current is absent", async () => {
    const f = fixture();
    const connect = vi.fn();
    const admission = f.installer.createAdmission(
      { getBinding: async () => undefined, bindConnection: vi.fn() },
      connect,
    );
    await expect(admission.resolveBinding(f.targetId)).resolves.toBeUndefined();
    expect(f.run).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects retained legacy bindings and explicit legacy verification before execution", async () => {
    const f = fixture();
    const runtime: RemoteAgentRuntime = {
      generation: "legacy",
      version: f.artifact.version,
      sha256: f.artifact.sha256,
      buildDigest: f.artifact.buildDigest,
      targetTriple: f.artifact.targetTriple,
      origin: "legacy-external",
      binaryPath: "/untrusted/bin/current",
      statePath: "/untrusted/state",
      socketPath: "/untrusted/state/supervisor.sock",
      logPath: "/untrusted/state/supervisor.log",
    };
    const connect = vi.fn();
    const admission = f.installer.createAdmission(
      {
        getBinding: async () => ({ runtime, expectedEpoch: "legacy-epoch" }),
        bindConnection: vi.fn(),
      },
      connect,
    );
    await expect(admission.resolveBinding(f.targetId)).rejects.toThrow("managed signed runtime");
    expect(() => admission.verify(f.targetId, runtime)).toThrow("managed signed runtime");
    expect(f.run).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it.each(["legacy", "unsigned"] as const)(
    "rejects a %s current selection before any executable probe",
    async (kind) => {
      const f = fixture();
      await f.installer.install({ executionTargetId: f.targetId, source: f.source });
      const state = await f.registry.read();
      const build = state.builds[0]!;
      const runtime: RemoteAgentRuntime = {
        ...build.runtime,
        origin: kind === "legacy" ? "legacy-external" : "managed",
      };
      const id = remoteAgentBuildId(runtime);
      f.replace({
        ...emptyRemoteAgentRegistry(),
        current: id,
        builds: [
          {
            ...build,
            id,
            authenticated: kind !== "unsigned",
            runtime,
          },
        ],
      });
      f.run.mockClear();
      const connect = vi.fn();
      const admission = f.installer.createAdmission(
        { getBinding: async () => undefined, bindConnection: vi.fn() },
        connect,
      );
      await expect(admission.resolveBinding(f.targetId)).rejects.toThrow(/managed/);
      expect(f.run).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
    },
  );

  it("reuses signed staging, immutable publication, registry pins and ready admission without SSH", async () => {
    const f = fixture();
    const result = await f.installer.install({ executionTargetId: f.targetId, source: f.source });
    let state = await f.registry.read();
    const build = state.builds[0]!;
    expect(result.binaryPath).toBe(build.runtime.binaryPath);
    expect(build.authenticated).toBe(true);
    expect(build.binary).toBe("present");
    expect(state.stages[0]?.phase).toBe("published");
    expect(
      f.run.mock.calls.some(([, script]) => script.includes('ln "$staged" "$installed"')),
    ).toBe(true);
    await f.registry.update((current) =>
      pinRemoteAgentBuild(current, "terminal:fixture", build.id),
    );
    state = await f.registry.read();
    f.replace({
      ...state,
      current: build.id,
      launches: [
        { id: "launch-fixture", buildId: build.id, phase: "ready", epoch: "fixture-epoch" },
      ],
    });
    const bindConnection = vi.fn(async () => {});
    const connect = vi.fn();
    const admission = f.installer.createAdmission(
      { getBinding: async () => undefined, bindConnection },
      connect,
    );
    const binding = await admission.resolveBinding(f.targetId);
    expect(binding?.expectedEpoch).toBe("fixture-epoch");
    expect(binding?.runtime).toEqual(build.runtime);
    expect(bindConnection).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();
    expect((await f.registry.read()).pins).toEqual([
      { owner: "terminal:fixture", buildId: build.id },
    ]);
    expect(runSshCommand).not.toHaveBeenCalled();
  });
});

describe("local supervisor cleanup reference authority", () => {
  it("keeps cleanup closed without complete references and never falls through to SSH", async () => {
    const f = fixture();
    expect(() => f.installer.cleanup("ssh:other")).toThrow("another authority");
    await expect(f.installer.cleanup(f.targetId)).rejects.toThrow(
      "complete durable service and owner references",
    );
    expect(runSshCommand).not.toHaveBeenCalled();
  });
  it("uses the same explicit reference source for local cleanup", async () => {
    const f = fixture();
    const references = vi.fn(async () => new Set<string>());
    const installer = makeLocalSupervisorInstaller({
      control: f.control,
      referencedBuildIds: references,
    });
    expect(await installer.cleanup(f.targetId)).toMatchObject({ deleted: 0 });
    expect(references).toHaveBeenCalledWith(f.targetId);
    expect(runSshCommand).not.toHaveBeenCalled();
  });
});
