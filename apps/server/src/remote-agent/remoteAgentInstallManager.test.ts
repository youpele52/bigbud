import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteAgentStageDefinitiveError } from "./remoteAgentInstall.stage.ts";
import {
  makeRemoteAgentInstallManager,
  parseRemoteAgentInstallSource,
} from "./remoteAgentInstallManager.ts";
import {
  artifact,
  bytes,
  installInput,
  installManagerFixture,
  paths,
} from "./remoteAgentInstallManager.fixtures.ts";

afterEach(() => vi.unstubAllGlobals());
describe("remote agent production staging manager", () => {
  it.each(["SSH unavailable", "authentication failed", "network timeout"])(
    "does not quarantine after %s",
    async (message) => {
      const fixture = installManagerFixture({
        verifyInstalledAgent: async () => {
          throw new Error(message);
        },
      });
      await expect(fixture.manager.install(installInput)).rejects.toThrow(message);
      const state = await fixture.control.registry.read();
      expect(state.builds[0]?.health).toBe("staged");
      expect(state.stages[0]).toMatchObject({ phase: "failed", failure: "ambiguous" });
    },
  );
  it("reserves before installing, checks the immutable path and publishes without startup", async () => {
    const fixture = installManagerFixture({
      installArtifact: async () => {
        expect((await fixture.control.registry.read()).stages[0]?.phase).toBe("reserved");
        return paths;
      },
    });
    expect(await fixture.manager.install(installInput)).toMatchObject({
      status: "staged",
      binaryPath: paths.installedBinary,
    });
    expect(fixture.verifyInstalledAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        binaryPath: `${fixture.control.root}/bin/${artifact.version}/${artifact.sha256}/bigbud-remote-agent`,
      }),
    );
    const state = await fixture.control.registry.read();
    expect(state.pending).toBe(state.builds[0]?.id);
    expect(state.current).toBeNull();
    expect(state.launches).toEqual([]);
    expect(fixture.runRemoteCommand).not.toHaveBeenCalled();
  });

  it("uses only a stateless check before reporting staged success", async () => {
    const control = installManagerFixture().control;
    const runRemoteCommand = vi.fn(async () => ({
      stdout: "bigbud-remote-agent 0.2.207 1 2 fixture linux aarch64",
    }));
    const manager = makeRemoteAgentInstallManager({
      openControl: async () => control,
      runRemoteCommand,
      probePlatform: async () => ({
        operatingSystem: "linux",
        architecture: "aarch64",
        targetTriple: artifact.targetTriple,
      }),
      readArtifactBytes: async () => bytes,
      installArtifact: async () => paths,
    });
    await manager.install(installInput);
    expect(runRemoteCommand).toHaveBeenCalledOnce();
    expect(JSON.stringify(runRemoteCommand.mock.calls)).toContain("--check");
    expect(JSON.stringify(runRemoteCommand.mock.calls)).not.toContain("--supervisor");
  });

  it("releases a definitive check failure without changing old selection", async () => {
    const fixture = installManagerFixture({
      verifyInstalledAgent: async () => {
        throw new RemoteAgentStageDefinitiveError("candidate mismatch");
      },
    });
    await expect(fixture.manager.install(installInput)).rejects.toThrow("candidate mismatch");
    expect(await fixture.control.registry.read()).toMatchObject({
      current: null,
      pending: null,
      launches: [],
    });
    const state = await fixture.control.registry.read();
    expect(state.stages).toEqual([]);
    expect(state.builds[0]?.health).toBe("quarantined");
    expect(fixture.runRemoteCommand).not.toHaveBeenCalled();
  });

  it("serializes the complete stage/check/publication transaction per target", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const verify = vi.fn(async () => {
      await gate;
    });
    const fixture = installManagerFixture({ verifyInstalledAgent: verify });
    const first = fixture.manager.install(installInput);
    await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
    const second = fixture.manager.install(installInput);
    await Promise.resolve();
    expect(fixture.installArtifact).toHaveBeenCalledOnce();
    release();
    await Promise.all([first, second]);
    expect(fixture.installArtifact).toHaveBeenCalledTimes(2);
  });

  it("allows signature bypass only for the internally marked development source", async () => {
    const fixture = installManagerFixture();
    await fixture.manager.install(installInput);
    expect(fixture.installArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ skipSignatureVerification: true }),
    );
    await expect(
      fixture.manager.install({
        ...installInput,
        source: { ...installInput.source, allowUntrustedDevelopmentArtifact: undefined } as never,
      }),
    ).rejects.toThrow();
    expect(fixture.installArtifact).toHaveBeenCalledOnce();
  });

  it("does not mutate unsupported targets or invalid artifact bytes", async () => {
    const unsupported = installManagerFixture({
      probePlatform: async () => ({
        operatingSystem: "darwin",
        architecture: "arm64",
        targetTriple: null,
      }),
    });
    await expect(unsupported.manager.install(installInput)).rejects.toThrow("unsupported");
    expect(unsupported.installArtifact).not.toHaveBeenCalled();
    const corrupt = installManagerFixture({ readArtifactBytes: async () => new Uint8Array([9]) });
    await expect(corrupt.manager.install(installInput)).rejects.toThrow();
    expect(corrupt.installArtifact).not.toHaveBeenCalled();
  });

  it("validates manifest and trust-store inputs", () => {
    expect(() => parseRemoteAgentInstallSource({ manifest: {}, trustStore: {} })).toThrow(
      "manifest schema",
    );
    expect(() =>
      parseRemoteAgentInstallSource({ manifest: { schemaVersion: 1, artifacts: [] } }),
    ).toThrow("trust store");
  });
});
