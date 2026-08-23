import { createHash, generateKeyPairSync, sign } from "node:crypto";

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
  buildRemoteAgentActivationScript,
  buildRemoteAgentInstallScript,
  buildRemoteAgentRollbackScript,
} from "./remoteAgentInstall.ts";

const bytes = new Uint8Array([1, 2, 3]);
const manifest = parseRemoteAgentArtifactManifest({
  schemaVersion: 1,
  artifacts: [
    {
      version: "0.1.0",
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
    const paths = buildRemoteAgentInstallPaths("0.1.0");
    expect(paths.versionRoot).toBe("$HOME/.bigbud/agent/bin/0.1.0");
    const script = buildRemoteAgentInstallScript({
      artifact: selectRemoteAgentArtifact(manifest, "x86_64-unknown-linux-gnu"),
      targetTriple: "x86_64-unknown-linux-gnu",
      stagedBase64: "AQID",
    });
    expect(script.command).toContain("umask 077");
    expect(script.command).toContain("sha256sum");
    expect(script.command).toContain("mv -f");
    expect(script.command).toContain('[ -e "$path" ] || [ -L "$path" ]');
    expect(script.command).not.toContain("StrictHostKeyChecking=no");
    expect(script.stdin).toBe("AQID");
  });

  it("keeps activation and rollback atomic after a verified install", () => {
    const activation = buildRemoteAgentActivationScript("0.1.0");
    expect(activation).toContain("mv -Tf");
    expect(activation).toContain("current_target=$(readlink");
    expect(activation).toContain("bin_root=$HOME/.bigbud/agent/bin");
    expect(activation).toContain('test ! -L "$installed"');
    expect(activation).toContain('[ -e "$active" ] || [ -L "$active" ]');

    const rollback = buildRemoteAgentRollbackScript();
    expect(rollback).toContain('if [ ! -L "$previous" ]; then exit 0; fi');
    expect(rollback).toContain("previous_target=$(readlink");
    expect(rollback).toContain("mv -Tf");
  });
});
