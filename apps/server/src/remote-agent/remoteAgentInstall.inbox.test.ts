import { describe, expect, it, vi } from "vitest";
import { RemoteAgentRemoteCommandError } from "./remoteAgentDiagnostics.ts";
import { remoteAgentFailureDetail } from "./remoteAgentFailure.ts";
import {
  buildRemoteAgentInboxAdoptionScript,
  buildRemoteAgentPlacedProbeScript,
  parseRemoteAgentPlacedState,
} from "./remoteAgentInstall.inbox.ts";
import {
  artifact,
  installInput,
  installManagerFixture,
} from "./remoteAgentInstallManager.fixtures.ts";

describe("manual inbox placement", () => {
  it("probes managed then inbox placement without executing or mutating anything", () => {
    const probe = buildRemoteAgentPlacedProbeScript(artifact);
    expect(probe).toContain(`.bigbud/agent/inbox/${artifact.sha256}/bigbud-remote-agent`);
    expect(probe).toContain(`-eq '${artifact.sizeBytes}'`);
    expect(probe).not.toMatch(/\brm\b|\bmv\b|\bln\b|--check|exec /);
    expect(parseRemoteAgentPlacedState("inbox\n")).toBe("inbox");
    expect(parseRemoteAgentPlacedState("motd noise\nmanaged")).toBe("managed");
    expect(parseRemoteAgentPlacedState("inbox-conflict")).toBe("inbox-conflict");
    expect(parseRemoteAgentPlacedState("unexpected")).toBe("absent");
  });

  it("promotes under the staging fence, re-verifies copied bytes and removes only afterwards", () => {
    const { command, paths } = buildRemoteAgentInboxAdoptionScript({
      artifact,
      targetTriple: artifact.targetTriple,
      reservationId: "reservation-1",
    });
    expect(paths.installedBinary).toContain(`${artifact.version}/${artifact.sha256}`);
    expect(command.indexOf("flock -n -x 9")).toBeLessThan(command.indexOf('cat -- "$candidate"'));
    expect(command.indexOf('verified_file "$staged"')).toBeLessThan(
      command.indexOf('ln "$staged" "$installed"'),
    );
    expect(command.indexOf('ln "$staged" "$installed"')).toBeLessThan(
      command.indexOf('rm -f -- "$candidate"'),
    );
    expect(command).toContain('"$inbox_root/' + artifact.sha256 + '"');
    expect(command).not.toMatch(/"\$candidate" --check|exec "\$candidate"/);
    expect(() =>
      buildRemoteAgentInboxAdoptionScript({
        artifact,
        targetTriple: "x86_64-unknown-linux-musl",
      }),
    ).toThrow("does not match");
  });

  it("explains a mismatched candidate", () => {
    const failure = new RemoteAgentRemoteCommandError(
      "install",
      66,
      false,
      "bigbud-install: inbox candidate missing or does not match the signed build",
    );
    expect(remoteAgentFailureDetail(failure)).toContain("~/.bigbud/agent/inbox");
  });
});

describe("install manager placement", () => {
  it.each(["managed", "inbox"] as const)(
    "adopts %s bytes without downloading or uploading",
    async (placement) => {
      const readArtifactBytes = vi.fn(async () => new Uint8Array([1]));
      const adoptPlacedArtifact = vi.fn(async () => ({}) as never);
      const fixture = installManagerFixture({
        probePlacedArtifact: async () => placement,
        readArtifactBytes,
        adoptPlacedArtifact,
      });
      const result = await fixture.manager.install(installInput);
      expect(result).toMatchObject({ placement, inboxConflict: false, status: "staged" });
      expect(readArtifactBytes).not.toHaveBeenCalled();
      expect(fixture.installArtifact).not.toHaveBeenCalled();
      expect(adoptPlacedArtifact).toHaveBeenCalledWith(
        expect.objectContaining({ reservationId: expect.any(String) }),
      );
      expect(fixture.verifyInstalledAgent).toHaveBeenCalledOnce();
    },
  );

  it("uploads and reports a conflicting inbox candidate without touching it", async () => {
    const adoptPlacedArtifact = vi.fn();
    const fixture = installManagerFixture({
      probePlacedArtifact: async () => "inbox-conflict",
      adoptPlacedArtifact,
    });
    const result = await fixture.manager.install(installInput);
    expect(result).toMatchObject({ placement: "upload", inboxConflict: true });
    expect(fixture.installArtifact).toHaveBeenCalledOnce();
    expect(adoptPlacedArtifact).not.toHaveBeenCalled();
  });
});
