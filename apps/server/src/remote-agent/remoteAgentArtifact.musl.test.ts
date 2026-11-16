import { describe, expect, it } from "vitest";
import {
  isRemoteAgentTargetTriple,
  parseRemoteAgentArtifactManifest,
  remoteAgentTargetCandidates,
  selectRemoteAgentArtifact,
  type RemoteAgentTargetTriple,
} from "./remoteAgentArtifact.ts";
import { validateRemoteAgentRuntime } from "./remoteAgentRuntime.ts";

const entry = (targetTriple: string, digit: string) => ({
  version: "0.3.4",
  buildDigest: "digest",
  protocolMajor: 1,
  protocolMinor: 5,
  targetTriple,
  sizeBytes: 1,
  sha256: digit.repeat(64),
  signature: { algorithm: "ed25519", keyId: "k", value: "v" },
  url: `https://example.invalid/${targetTriple}`,
});

const transition = parseRemoteAgentArtifactManifest({
  schemaVersion: 1,
  artifacts: [
    entry("x86_64-unknown-linux-musl", "1"),
    entry("aarch64-unknown-linux-musl", "2"),
    entry("x86_64-unknown-linux-gnu", "3"),
    entry("aarch64-unknown-linux-gnu", "4"),
  ],
});

describe("static musl remote agent selection", () => {
  it("prefers musl, keeps glibc as a fallback and never offers glibc to musl hosts", () => {
    expect(remoteAgentTargetCandidates("x86_64-unknown-linux-gnu")).toEqual([
      "x86_64-unknown-linux-musl",
      "x86_64-unknown-linux-gnu",
    ]);
    expect(remoteAgentTargetCandidates("aarch64-unknown-linux-gnu", "musl")).toEqual([
      "aarch64-unknown-linux-musl",
    ]);
    const select = (host: RemoteAgentTargetTriple, libc?: "glibc" | "musl") =>
      selectRemoteAgentArtifact(transition, remoteAgentTargetCandidates(host, libc)).targetTriple;
    expect(select("x86_64-unknown-linux-gnu", "glibc")).toBe("x86_64-unknown-linux-musl");
    expect(select("aarch64-unknown-linux-gnu")).toBe("aarch64-unknown-linux-musl");
  });

  it("falls back to a historic glibc-only manifest and refuses it for musl hosts", () => {
    const legacy = parseRemoteAgentArtifactManifest({
      schemaVersion: 1,
      artifacts: [entry("x86_64-unknown-linux-gnu", "3")],
    });
    expect(
      selectRemoteAgentArtifact(legacy, remoteAgentTargetCandidates("x86_64-unknown-linux-gnu"))
        .targetTriple,
    ).toBe("x86_64-unknown-linux-gnu");
    expect(() =>
      selectRemoteAgentArtifact(
        legacy,
        remoteAgentTargetCandidates("x86_64-unknown-linux-gnu", "musl"),
      ),
    ).toThrow("x86_64-unknown-linux-musl");
  });

  it("skips unknown future targets but rejects a manifest with none it supports", () => {
    const future = parseRemoteAgentArtifactManifest({
      schemaVersion: 1,
      artifacts: [
        entry("riscv64gc-unknown-linux-musl", "5"),
        entry("x86_64-unknown-linux-gnu", "3"),
      ],
    });
    expect(future.artifacts.map((artifact) => artifact.targetTriple)).toEqual([
      "x86_64-unknown-linux-gnu",
    ]);
    expect(() =>
      parseRemoteAgentArtifactManifest({
        schemaVersion: 1,
        artifacts: [entry("riscv64gc-unknown-linux-musl", "5")],
      }),
    ).toThrow("no artifacts for a supported target");
    expect(isRemoteAgentTargetTriple("x86_64-unknown-linux-musl")).toBe(true);
    expect(isRemoteAgentTargetTriple("x86_64-apple-darwin")).toBe(false);
  });

  it("accepts musl runtimes in the remote registry", () => {
    const root = "/home/u/.bigbud/agent";
    expect(() =>
      validateRemoteAgentRuntime({
        generation: "g-1",
        version: "0.3.4",
        sha256: "1".repeat(64),
        buildDigest: "digest",
        targetTriple: "x86_64-unknown-linux-musl",
        origin: "managed",
        binaryPath: `${root}/bin/0.3.4/${"1".repeat(64)}/bigbud-remote-agent`,
        statePath: `${root}/runtimes/g-1`,
        socketPath: `${root}/runtimes/g-1/supervisor.sock`,
        logPath: `${root}/runtimes/g-1/supervisor.log`,
      }),
    ).not.toThrow();
  });
});
