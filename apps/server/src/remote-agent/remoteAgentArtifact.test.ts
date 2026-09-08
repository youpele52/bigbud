import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseRemoteAgentArtifactManifest,
  canonicalizeRemoteAgentArtifact,
  resolveRemoteAgentTargetTriple,
  selectRemoteAgentArtifact,
  verifyRemoteAgentArtifactSignature,
  verifyRemoteAgentArtifactBytes,
} from "./remoteAgentArtifact.ts";
import {
  buildRemoteAgentInstallPaths,
  buildRemoteAgentInstallScript,
} from "./remoteAgentInstall.ts";
import {
  buildRemoteAgentActivationFinalizeScript,
  buildRemoteAgentActivationScript,
  buildRemoteAgentRollbackScript,
} from "./remoteAgentInstall.activation.ts";

const bytes = new Uint8Array([1, 2, 3]);
const manifest = parseRemoteAgentArtifactManifest({
  schemaVersion: 1,
  artifacts: [
    {
      version: "0.1.0",
      buildDigest: "build-0.1.0",
      protocolMajor: 1,
      protocolMinor: 0,
      targetTriple: "x86_64-unknown-linux-gnu",
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      signature: { algorithm: "ed25519", keyId: "release-1", value: "signature" },
      bundledPath: "dist/agent-x86_64",
    },
  ],
});

describe("remote agent artifact lifecycle", () => {
  it("maps only the initially supported Linux targets", () => {
    expect(resolveRemoteAgentTargetTriple("linux", "x86_64")).toBe("x86_64-unknown-linux-gnu");
    expect(resolveRemoteAgentTargetTriple("linux", "arm64")).toBe("aarch64-unknown-linux-gnu");
    expect(resolveRemoteAgentTargetTriple("darwin", "arm64")).toBeNull();
  });

  it("requires manifest metadata and verifies the selected artifact", () => {
    const artifact = selectRemoteAgentArtifact(manifest, "x86_64-unknown-linux-gnu");
    expect(() => verifyRemoteAgentArtifactBytes(artifact, bytes)).not.toThrow();
    expect(() => verifyRemoteAgentArtifactBytes(artifact, new Uint8Array([9]))).toThrow(
      "size mismatch",
    );
    expect(() =>
      parseRemoteAgentArtifactManifest({
        schemaVersion: 1,
        artifacts: [{ ...artifact, signature: undefined }],
      }),
    ).toThrow("signature metadata is required");
  });

  it("rejects duplicate target entries in a release manifest", () => {
    const artifact = selectRemoteAgentArtifact(manifest, "x86_64-unknown-linux-gnu");
    expect(() =>
      parseRemoteAgentArtifactManifest({
        schemaVersion: 1,
        artifacts: [artifact, artifact],
      }),
    ).toThrow("duplicate targets");
  });

  it("verifies an Ed25519 signature against the trusted release key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const unsigned = selectRemoteAgentArtifact(manifest, "x86_64-unknown-linux-gnu");
    const signed = parseRemoteAgentArtifactManifest({
      schemaVersion: 1,
      artifacts: [
        {
          ...unsigned,
          signature: {
            algorithm: "ed25519",
            keyId: "generated",
            value: sign(
              null,
              Buffer.from(canonicalizeRemoteAgentArtifact(unsigned)),
              privateKey,
            ).toString("base64"),
          },
        },
      ],
    });
    verifyRemoteAgentArtifactSignature(signed.artifacts[0]!, {
      generated: publicKey.export({ type: "spki", format: "pem" }).toString(),
    });
  });

  it("builds user-only versioned install paths and an atomic verification script", () => {
    const artifact = selectRemoteAgentArtifact(manifest, "x86_64-unknown-linux-gnu");
    const paths = buildRemoteAgentInstallPaths(artifact);
    expect(paths.versionRoot).toBe("$HOME/.bigbud/agent/bin/0.1.0");
    expect(paths.buildRoot).toBe(`$HOME/.bigbud/agent/bin/0.1.0/${artifact.sha256}`);
    const script = buildRemoteAgentInstallScript({
      artifact,
      targetTriple: "x86_64-unknown-linux-gnu",
      stagedBase64: "AQID",
    });
    expect(script.command).toContain("umask 077");
    expect(script.command).toContain("sha256sum");
    expect(script.command).toContain('mktemp "$build_root/');
    expect(script.command).toContain('ln "$staged" "$installed"');
    expect(script.command).not.toContain("target-triple");
    expect(script.command).toContain('[ -e "$path" ] || [ -L "$path" ]');
    expect(script.command).not.toContain("StrictHostKeyChecking=no");
    expect(script.stdin).toBe("AQID");
  });

  it("keeps activation and rollback atomic after a verified install", () => {
    const artifact = selectRemoteAgentArtifact(manifest, "x86_64-unknown-linux-gnu");
    const activation = buildRemoteAgentActivationScript(artifact);
    expect(activation).toContain("mv -Tf");
    expect(activation).toContain("current_target=$(validate_agent_target");
    expect(activation).toContain("bin_root=$HOME/.bigbud/agent/bin");
    expect(activation).toContain('test ! -L "$candidate"');
    expect(activation).toContain('validate_link_slot "$active"');
    expect(activation).toContain('pending="$state_root/activation.pending"');

    const rollback = buildRemoteAgentRollbackScript(artifact);
    expect(rollback).toContain('if [ "$active_target" = "$pending_candidate_target" ]');
    expect(rollback).toContain("pending_baseline_target=$(validate_agent_target");
    expect(rollback).toContain("mv -Tf");
  });

  it("keeps same-version builds distinct so rollback retains the prior binary", () => {
    const oldIdentity = { version: "0.1.0", sha256: "1".repeat(64) };
    const newIdentity = { version: "0.1.0", sha256: "2".repeat(64) };
    const oldPaths = buildRemoteAgentInstallPaths(oldIdentity);
    const newPaths = buildRemoteAgentInstallPaths(newIdentity);

    expect(newPaths.installedBinary).not.toBe(oldPaths.installedBinary);
    expect(buildRemoteAgentActivationScript(newIdentity)).toContain(
      `candidate=${newPaths.installedBinary}`,
    );
    expect(buildRemoteAgentRollbackScript(newIdentity)).toContain(
      "expected_candidate=$candidate_canonical",
    );
    expect(() => buildRemoteAgentInstallPaths({ version: "0.1.0", sha256: "../unsafe" })).toThrow(
      "SHA-256",
    );
  });

  it.runIf(process.platform === "linux")(
    "restores untouched bytes when a same-version build is rolled back",
    () => {
      const home = mkdtempSync(join(tmpdir(), "bigbud-agent-rollback-"));
      const base = selectRemoteAgentArtifact(manifest, "x86_64-unknown-linux-gnu");
      const oldBytes = Buffer.from("old build");
      const newBytes = Buffer.from("new build");
      const oldArtifact = {
        ...base,
        buildDigest: "old-build",
        sizeBytes: oldBytes.byteLength,
        sha256: createHash("sha256").update(oldBytes).digest("hex"),
      };
      const newArtifact = {
        ...base,
        buildDigest: "new-build",
        sizeBytes: newBytes.byteLength,
        sha256: createHash("sha256").update(newBytes).digest("hex"),
      };
      const run = (script: string, stdin?: string) =>
        execFileSync("sh", ["-lc", script], {
          env: { ...process.env, HOME: home },
          ...(stdin ? { input: stdin } : {}),
        });

      try {
        for (const [artifact, bytes] of [
          [oldArtifact, oldBytes],
          [newArtifact, newBytes],
        ] as const) {
          const install = buildRemoteAgentInstallScript({
            artifact,
            targetTriple: artifact.targetTriple,
            stagedBase64: bytes.toString("base64"),
          });
          run(install.command, install.stdin);
          run(buildRemoteAgentActivationScript(artifact));
          if (artifact === oldArtifact) {
            run(buildRemoteAgentActivationFinalizeScript(artifact));
          }
        }

        const oldBinary = buildRemoteAgentInstallPaths(oldArtifact).installedBinary.replace(
          "$HOME",
          home,
        );
        const newBinary = buildRemoteAgentInstallPaths(newArtifact).installedBinary.replace(
          "$HOME",
          home,
        );
        const active = join(home, ".bigbud/agent/bin/current");
        const previous = join(home, ".bigbud/agent/bin/previous");
        expect(readlinkSync(active)).toBe(newBinary);
        expect(readlinkSync(previous)).toBe(oldBinary);
        expect(readFileSync(oldBinary)).toEqual(oldBytes);
        expect(readFileSync(newBinary)).toEqual(newBytes);

        run(buildRemoteAgentRollbackScript(newArtifact));
        expect(readlinkSync(active)).toBe(oldBinary);
        expect(readFileSync(active)).toEqual(oldBytes);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "removes a failed first-install activation without deleting its immutable binary",
    () => {
      const home = mkdtempSync(join(tmpdir(), "bigbud-agent-first-rollback-"));
      const base = selectRemoteAgentArtifact(manifest, "x86_64-unknown-linux-gnu");
      const artifact = {
        ...base,
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      const run = (script: string, stdin?: string) =>
        execFileSync("sh", ["-lc", script], {
          env: { ...process.env, HOME: home },
          ...(stdin ? { input: stdin } : {}),
        });

      try {
        const install = buildRemoteAgentInstallScript({
          artifact,
          targetTriple: artifact.targetTriple,
          stagedBase64: Buffer.from(bytes).toString("base64"),
        });
        run(install.command, install.stdin);
        run(buildRemoteAgentActivationScript(artifact));
        const active = join(home, ".bigbud/agent/bin/current");
        expect(existsSync(active)).toBe(true);

        run(buildRemoteAgentRollbackScript(artifact));
        expect(existsSync(active)).toBe(false);
        expect(existsSync(install.paths.installedBinary.replace("$HOME", home))).toBe(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects traversal targets without changing activation or rollback links",
    () => {
      const home = mkdtempSync(join(tmpdir(), "bigbud-agent-traversal-"));
      const base = selectRemoteAgentArtifact(manifest, "x86_64-unknown-linux-gnu");
      const artifact = {
        ...base,
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      const run = (script: string, stdin?: string) =>
        execFileSync("sh", ["-lc", script], {
          env: { ...process.env, HOME: home },
          ...(stdin ? { input: stdin } : {}),
        });

      try {
        const install = buildRemoteAgentInstallScript({
          artifact,
          targetTriple: artifact.targetTriple,
          stagedBase64: Buffer.from(bytes).toString("base64"),
        });
        run(install.command, install.stdin);
        const binRoot = join(home, ".bigbud/agent/bin");
        const active = join(binRoot, "current");
        const previous = join(binRoot, "previous");
        const outsideBinary = join(home, ".bigbud/outside/bigbud-remote-agent");
        mkdirSync(join(home, ".bigbud/outside"), { recursive: true, mode: 0o700 });
        writeFileSync(outsideBinary, "outside");
        chmodSync(outsideBinary, 0o700);
        const traversalTarget = `${binRoot}/../../outside/bigbud-remote-agent`;
        symlinkSync(traversalTarget, active);

        expect(() => run(buildRemoteAgentActivationScript(artifact))).toThrow();
        expect(readlinkSync(active)).toBe(traversalTarget);
        expect(existsSync(previous)).toBe(false);

        unlinkSync(active);
        run(buildRemoteAgentActivationScript(artifact));
        symlinkSync(traversalTarget, previous);
        const candidateTarget = readlinkSync(active);

        expect(() => run(buildRemoteAgentRollbackScript(artifact))).toThrow();
        expect(readlinkSync(active)).toBe(candidateTarget);
        expect(readlinkSync(previous)).toBe(traversalTarget);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
