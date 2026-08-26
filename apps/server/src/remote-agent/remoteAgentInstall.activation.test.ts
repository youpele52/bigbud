import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildRemoteAgentActivationFinalizeScript,
  buildRemoteAgentActivationRecoveryScript,
  buildRemoteAgentActivationScript,
} from "./remoteAgentInstall.activation.ts";
import {
  buildRemoteAgentInstallPaths,
  buildRemoteAgentInstallScript,
} from "./remoteAgentInstall.ts";
import { runRemoteAgentActivationTransaction } from "./remoteAgentInstall.transaction.ts";

const targetTriple = "x86_64-unknown-linux-gnu" as const;

function artifactFor(contents: string) {
  const bytes = Buffer.from(contents);
  return {
    artifact: {
      version: "0.1.0",
      buildDigest: `build-${contents}`,
      protocolMajor: 1,
      protocolMinor: 0,
      targetTriple,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      signature: { algorithm: "ed25519" as const, keyId: "test", value: "test" },
      bundledPath: "unused",
    },
    bytes,
  };
}

function replaceOnce(script: string, boundary: string, replacement: string): string {
  expect(script.split(boundary)).toHaveLength(2);
  return script.replace(boundary, replacement);
}

function makeLinuxHarness() {
  const home = mkdtempSync(join(tmpdir(), "bigbud-agent-activation-"));
  const run = (script: string, stdin?: string) =>
    execFileSync("sh", ["-lc", script], {
      env: { ...process.env, HOME: home },
      ...(stdin ? { input: stdin } : {}),
    });
  const install = (build: ReturnType<typeof artifactFor>) => {
    const script = buildRemoteAgentInstallScript({
      artifact: build.artifact,
      targetTriple,
      stagedBase64: build.bytes.toString("base64"),
    });
    run(script.command, script.stdin);
  };
  return { home, run, install };
}

async function runActivationTransaction(input: {
  readonly harness: ReturnType<typeof makeLinuxHarness>;
  readonly build: ReturnType<typeof artifactFor>;
  readonly loseFinalizeResponses: boolean;
}) {
  const paths = buildRemoteAgentInstallPaths(input.build.artifact);
  const active = paths.activeLink.replace("$HOME", input.harness.home);
  const candidate = paths.installedBinary.replace("$HOME", input.harness.home);
  let finalizeAttempts = 0;
  let verificationCount = 0;
  await runRemoteAgentActivationTransaction({
    executionTargetId: "ssh:test",
    artifact: input.build.artifact,
    paths,
    runRemoteCommand: async (commandInput: unknown) => {
      const script = String((commandInput as { args?: readonly string[] }).args?.[1] ?? "");
      if (script.includes("--prepare-supervisor")) return { stdout: "" };
      const stdout = input.harness.run(script).toString();
      if (script.includes("printf 'finalized\n'")) {
        finalizeAttempts += 1;
        if (input.loseFinalizeResponses && finalizeAttempts <= 2) {
          throw new Error("finalize response lost");
        }
      }
      return { stdout };
    },
    verifyInstalledAgent: async () => {
      verificationCount += 1;
      expect(readlinkSync(active)).toBe(candidate);
      expect(readFileSync(candidate)).toEqual(input.build.bytes);
    },
  });
  return { finalizeAttempts, verificationCount };
}

describe.runIf(process.platform === "linux")("remote agent activation transaction", () => {
  it("recovers a lost activation response and permits a clean retry", () => {
    const harness = makeLinuxHarness();
    const oldBuild = artifactFor("old");
    const newBuild = artifactFor("new");
    const active = join(harness.home, ".bigbud/agent/bin/current");
    const pending = join(harness.home, ".bigbud/agent/state/activation.pending");
    const previous = join(harness.home, ".bigbud/agent/bin/previous");
    const oldBinary = buildRemoteAgentInstallPaths(oldBuild.artifact).installedBinary.replace(
      "$HOME",
      harness.home,
    );
    const newBinary = buildRemoteAgentInstallPaths(newBuild.artifact).installedBinary.replace(
      "$HOME",
      harness.home,
    );

    try {
      harness.install(oldBuild);
      harness.run(buildRemoteAgentActivationScript(oldBuild.artifact));
      harness.run(buildRemoteAgentActivationFinalizeScript(oldBuild.artifact));
      harness.install(newBuild);
      const interrupted = replaceOnce(
        buildRemoteAgentActivationScript(newBuild.artifact),
        'mv -Tf "$active_temporary" "$active"',
        'mv -Tf "$active_temporary" "$active"\nexit 75',
      );

      expect(() => harness.run(interrupted)).toThrow();
      expect(readlinkSync(active)).toBe(newBinary);
      expect(readlinkSync(previous)).toBe(oldBinary);
      expect(existsSync(pending)).toBe(true);
      expect(
        harness.run(buildRemoteAgentActivationRecoveryScript(newBuild.artifact)).toString(),
      ).toBe("restored\n");
      expect(readlinkSync(active)).toBe(oldBinary);
      expect(readlinkSync(previous)).toBe(oldBinary);
      expect(existsSync(pending)).toBe(false);

      harness.run(buildRemoteAgentActivationScript(newBuild.artifact));
      harness.run(buildRemoteAgentActivationFinalizeScript(newBuild.artifact));
      expect(readlinkSync(active)).toBe(newBinary);
    } finally {
      rmSync(harness.home, { recursive: true, force: true });
    }
  });

  it("finishes recovery safely when interrupted after restoring current", () => {
    const harness = makeLinuxHarness();
    const oldBuild = artifactFor("old");
    const newBuild = artifactFor("new");
    const active = join(harness.home, ".bigbud/agent/bin/current");
    const pending = join(harness.home, ".bigbud/agent/state/activation.pending");
    const previous = join(harness.home, ".bigbud/agent/bin/previous");
    const oldBinary = buildRemoteAgentInstallPaths(oldBuild.artifact).installedBinary.replace(
      "$HOME",
      harness.home,
    );

    try {
      harness.install(oldBuild);
      harness.run(buildRemoteAgentActivationScript(oldBuild.artifact));
      harness.run(buildRemoteAgentActivationFinalizeScript(oldBuild.artifact));
      harness.install(newBuild);
      harness.run(buildRemoteAgentActivationScript(newBuild.artifact));
      const interrupted = replaceOnce(
        buildRemoteAgentActivationRecoveryScript(newBuild.artifact),
        'mv -Tf "$recovery_link" "$active"',
        'mv -Tf "$recovery_link" "$active"\nexit 75',
      );

      expect(() => harness.run(interrupted)).toThrow();
      expect(readlinkSync(active)).toBe(oldBinary);
      expect(readlinkSync(previous)).toBe(oldBinary);
      expect(existsSync(pending)).toBe(true);
      expect(readFileSync(oldBinary).toString()).toBe("old");
      expect(
        harness.run(buildRemoteAgentActivationRecoveryScript(newBuild.artifact)).toString(),
      ).toBe("unchanged\n");
      expect(readlinkSync(active)).toBe(oldBinary);
      expect(readlinkSync(previous)).toBe(oldBinary);
      expect(readFileSync(oldBinary).toString()).toBe("old");
      expect(existsSync(pending)).toBe(false);
    } finally {
      rmSync(harness.home, { recursive: true, force: true });
    }
  });

  it("removes an interrupted first activation and then retries successfully", () => {
    const harness = makeLinuxHarness();
    const build = artifactFor("first");
    const active = join(harness.home, ".bigbud/agent/bin/current");

    try {
      harness.install(build);
      const interrupted = replaceOnce(
        buildRemoteAgentActivationScript(build.artifact),
        'mv -Tf "$active_temporary" "$active"',
        'mv -Tf "$active_temporary" "$active"\nexit 75',
      );
      expect(() => harness.run(interrupted)).toThrow();

      expect(harness.run(buildRemoteAgentActivationRecoveryScript(build.artifact)).toString()).toBe(
        "removed\n",
      );
      expect(existsSync(active)).toBe(false);
      harness.run(buildRemoteAgentActivationScript(build.artifact));
      harness.run(buildRemoteAgentActivationFinalizeScript(build.artifact));
      expect(existsSync(active)).toBe(true);
    } finally {
      rmSync(harness.home, { recursive: true, force: true });
    }
  });

  it("does not roll back a candidate that was already active before the transaction", () => {
    const harness = makeLinuxHarness();
    const build = artifactFor("already-active");
    const active = join(harness.home, ".bigbud/agent/bin/current");
    const binary = buildRemoteAgentInstallPaths(build.artifact).installedBinary.replace(
      "$HOME",
      harness.home,
    );

    try {
      harness.install(build);
      harness.run(buildRemoteAgentActivationScript(build.artifact));
      harness.run(buildRemoteAgentActivationFinalizeScript(build.artifact));

      expect(harness.run(buildRemoteAgentActivationScript(build.artifact)).toString()).toBe(
        "unchanged\n",
      );
      expect(harness.run(buildRemoteAgentActivationRecoveryScript(build.artifact)).toString()).toBe(
        "unchanged\n",
      );
      expect(readlinkSync(active)).toBe(binary);
      expect(readFileSync(binary).toString()).toBe("already-active");
    } finally {
      rmSync(harness.home, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "upgrade", withBaseline: true },
    { name: "first install", withBaseline: false },
  ])(
    "reconciles committed $name finalization after both responses are lost",
    async ({ withBaseline }) => {
      const harness = makeLinuxHarness();
      const baseline = artifactFor("committed-baseline");
      const candidate = artifactFor(`committed-candidate-${withBaseline}`);
      const active = join(harness.home, ".bigbud/agent/bin/current");
      const pending = join(harness.home, ".bigbud/agent/state/activation.pending");
      const previous = join(harness.home, ".bigbud/agent/bin/previous");
      const candidateBinary = buildRemoteAgentInstallPaths(
        candidate.artifact,
      ).installedBinary.replace("$HOME", harness.home);
      const baselineBinary = buildRemoteAgentInstallPaths(
        baseline.artifact,
      ).installedBinary.replace("$HOME", harness.home);

      try {
        if (withBaseline) {
          harness.install(baseline);
          harness.run(buildRemoteAgentActivationScript(baseline.artifact));
          harness.run(buildRemoteAgentActivationFinalizeScript(baseline.artifact));
        }
        harness.install(candidate);

        await expect(
          runActivationTransaction({ harness, build: candidate, loseFinalizeResponses: true }),
        ).resolves.toEqual({ finalizeAttempts: 2, verificationCount: 2 });
        expect(readlinkSync(active)).toBe(candidateBinary);
        expect(existsSync(pending)).toBe(false);
        if (withBaseline) {
          expect(readlinkSync(previous)).toBe(baselineBinary);
        } else {
          expect(existsSync(previous)).toBe(false);
        }

        await expect(
          runActivationTransaction({ harness, build: candidate, loseFinalizeResponses: false }),
        ).resolves.toEqual({ finalizeAttempts: 1, verificationCount: 1 });
        expect(readlinkSync(active)).toBe(candidateBinary);
        expect(existsSync(pending)).toBe(false);
        if (withBaseline) expect(readlinkSync(previous)).toBe(baselineBinary);
      } finally {
        rmSync(harness.home, { recursive: true, force: true });
      }
    },
  );
});
