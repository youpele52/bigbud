import { describe, expect, it } from "vitest";
import { RemoteAgentRemoteCommandError } from "./remoteAgentDiagnostics.ts";
import { classifyRemoteAgentFailure } from "./remoteAgentFailure.classify.ts";
import { remoteAgentFailureDetail } from "./remoteAgentFailure.ts";
import { RemoteAgentPreflightError } from "./remoteAgentInstall.preflight.ts";
import { buildRemoteAgentInstallScript } from "./remoteAgentInstall.ts";
import { RemoteAgentCapacityUnavailableError } from "./remoteAgentInstall.stage.ts";
import { RemoteAgentInstallManagerError } from "./remoteAgentInstallManager.ts";

const remote = (
  stage: RemoteAgentRemoteCommandError["stage"],
  stderr: string,
  exitCode: number | null = 1,
  timedOut = false,
) => new RemoteAgentRemoteCommandError(stage, exitCode, timedOut, stderr);

describe("remote agent failure classification", () => {
  it("names the glibc floor from a real loader error", () => {
    const failure = remote(
      "check",
      [32, 34, 33]
        .map(
          (minor) =>
            `/tmp/a: /lib/x86_64-linux-gnu/libc.so.6: version \`GLIBC_2.${minor}' not found (required by /tmp/a)`,
        )
        .join("\n"),
    );
    expect(classifyRemoteAgentFailure(failure)).toMatchObject({ kind: "glibc-too-old" });
    expect(remoteAgentFailureDetail(failure)).toContain("needs GLIBC_2.34");
  });

  it("names missing GNU tools from shell and option errors", () => {
    expect(classifyRemoteAgentFailure(remote("install", "sh: 1: flock: not found"))).toMatchObject({
      kind: "missing-tool",
      message: expect.stringContaining("util-linux"),
    });
    expect(
      classifyRemoteAgentFailure(remote("install", "stat: illegal option -- c")),
    ).toMatchObject({ kind: "missing-tool", message: expect.stringContaining("stat -c") });
  });

  it("explains unsafe directories using the install script marker", () => {
    const failure = remote(
      "install",
      "bigbud-install: unsafe-directory .bigbud/agent/bin mode=755 owner=self",
      78,
    );
    expect(classifyRemoteAgentFailure(failure)).toMatchObject({
      kind: "directory-permissions",
      message: expect.stringContaining("chmod 700 ~/.bigbud/agent/bin"),
    });
  });

  it("makes the install script emit that marker instead of failing silently", () => {
    const artifact = {
      version: "0.3.3",
      buildDigest: "digest",
      protocolMajor: 1,
      protocolMinor: 3,
      targetTriple: "x86_64-unknown-linux-gnu" as const,
      sizeBytes: 1,
      sha256: "a".repeat(64),
      signature: { algorithm: "ed25519" as const, keyId: "k", value: "v" },
      bundledPath: "agent",
    };
    const { command } = buildRemoteAgentInstallScript({
      artifact,
      targetTriple: artifact.targetTriple,
      stagedBase64: "AA==",
    });
    expect(command).toContain("bigbud-install: unsafe-directory");
    expect(command).not.toContain(`test "$(stat -c '%a' "$path")" = "700"`);
  });

  it("distinguishes upload timeouts, held reservations and unknown failures", () => {
    expect(classifyRemoteAgentFailure(remote("install", "", null, true))?.kind).toBe(
      "upload-timeout",
    );
    expect(classifyRemoteAgentFailure(remote("install", "", 75))?.kind).toBe("install-in-progress");
    expect(
      remoteAgentFailureDetail(remote("install", "+ set -x trace\nNo space left on device", 1)),
    ).toBe("The remote agent upload failed (exit 1): No space left on device");
  });

  it("recognises capacity, unsupported platform and preflight refusals through causes", () => {
    const capacity = new Error("stage", {
      cause: new RemoteAgentCapacityUnavailableError("waiting-for-capacity"),
    });
    expect(classifyRemoteAgentFailure(capacity)?.kind).toBe("capacity-deferred");
    expect(
      classifyRemoteAgentFailure(
        new RemoteAgentInstallManagerError("Remote agent is unsupported on darwin/arm64."),
      )?.kind,
    ).toBe("unsupported-platform");
    expect(
      classifyRemoteAgentFailure(new RemoteAgentPreflightError("missing-tool", "missing"))?.kind,
    ).toBe("missing-tool");
    expect(classifyRemoteAgentFailure(new Error("other"))).toBeNull();
  });
});
