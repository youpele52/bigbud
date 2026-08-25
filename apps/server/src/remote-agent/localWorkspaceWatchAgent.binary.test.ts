import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LocalWorkspaceWatchAgentUnavailableError,
  resolveLocalWorkspaceWatchAgentBinary,
  verifyLocalWorkspaceWatchAgentBinary,
} from "./localWorkspaceWatchAgent.binary.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "bigbud-local-watch-agent-"));
  temporaryDirectories.push(directory);
  return directory;
}

function executable(path: string): string {
  writeFileSync(path, "binary");
  chmodSync(path, 0o755);
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("local workspace watcher agent binary", () => {
  it("prefers the explicit environment override", () => {
    const root = temporaryDirectory();
    const override = executable(join(root, "override-agent"));
    const packaged = executable(join(root, "packaged-agent"));

    expect(
      resolveLocalWorkspaceWatchAgentBinary({
        environment: { BIGBUD_LOCAL_WORKSPACE_AGENT_BINARY: override },
        packagedBinaryPath: packaged,
        platform: "linux",
        architecture: "x64",
        searchFrom: [],
        verifyBinary: () => {},
      }),
    ).toBe(override);
  });

  it("uses the supplied packaged binary before development discovery", () => {
    const root = temporaryDirectory();
    const packaged = executable(join(root, "packaged-agent"));
    expect(
      resolveLocalWorkspaceWatchAgentBinary({
        environment: {},
        packagedBinaryPath: packaged,
        platform: "linux",
        architecture: "x64",
        searchFrom: [],
        verifyBinary: () => {},
      }),
    ).toBe(packaged);
  });

  it("discovers the repository debug binary from a nested working directory", () => {
    const root = temporaryDirectory();
    const nested = join(root, "apps", "server");
    const target = join(root, "target", "debug");
    mkdirSync(nested, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(root, "Cargo.toml"), "[workspace]\n");
    const binary = executable(join(target, "bigbud-remote-agent"));

    expect(
      resolveLocalWorkspaceWatchAgentBinary({
        environment: {},
        platform: "linux",
        architecture: "x64",
        searchFrom: [nested],
        verifyBinary: () => {},
      }),
    ).toBe(binary);
  });

  it("locates the platform-specific binary shipped by the standalone server package", () => {
    const root = temporaryDirectory();
    const packageDirectory = join(root, "workspace-agent", "linux-x64");
    mkdirSync(packageDirectory, { recursive: true });
    const binary = executable(join(packageDirectory, "bigbud-remote-agent"));

    expect(
      resolveLocalWorkspaceWatchAgentBinary({
        environment: {},
        packageRoot: root,
        platform: "linux",
        architecture: "x64",
        searchFrom: [],
        verifyBinary: () => {},
      }),
    ).toBe(binary);
  });

  it("prefers the repository binary over a stale staged artifact during development", () => {
    const root = temporaryDirectory();
    const packageRoot = join(root, "apps", "server", "dist");
    const packageDirectory = join(packageRoot, "workspace-agent", "linux-x64");
    const target = join(root, "target", "debug");
    mkdirSync(packageDirectory, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(root, "Cargo.toml"), "[workspace]\n");
    executable(join(packageDirectory, "bigbud-remote-agent"));
    const repository = executable(join(target, "bigbud-remote-agent"));

    expect(
      resolveLocalWorkspaceWatchAgentBinary({
        environment: { BIGBUD_DESKTOP_PACKAGED: "0" },
        packageRoot,
        platform: "linux",
        architecture: "x64",
        searchFrom: [packageRoot],
        verifyBinary: () => {},
      }),
    ).toBe(repository);
  });

  it("keeps the staged artifact authoritative for packaged runtimes", () => {
    const root = temporaryDirectory();
    const packageRoot = join(root, "apps", "server", "dist");
    const packageDirectory = join(packageRoot, "workspace-agent", "linux-x64");
    const target = join(root, "target", "debug");
    mkdirSync(packageDirectory, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(root, "Cargo.toml"), "[workspace]\n");
    const packaged = executable(join(packageDirectory, "bigbud-remote-agent"));
    executable(join(target, "bigbud-remote-agent"));

    expect(
      resolveLocalWorkspaceWatchAgentBinary({
        environment: { BIGBUD_DESKTOP_PACKAGED: "1" },
        packageRoot,
        platform: "linux",
        architecture: "x64",
        searchFrom: [packageRoot],
        verifyBinary: () => {},
      }),
    ).toBe(packaged);
  });

  it("rejects a binary that fails platform and architecture verification", () => {
    const root = temporaryDirectory();
    const override = executable(join(root, "override-agent"));
    expect(() =>
      resolveLocalWorkspaceWatchAgentBinary({
        environment: { BIGBUD_LOCAL_WORKSPACE_AGENT_BINARY: override },
        platform: "linux",
        architecture: "x64",
        verifyBinary: () => {
          throw new LocalWorkspaceWatchAgentUnavailableError("wrong architecture");
        },
      }),
    ).toThrow("wrong architecture");
  });

  it("reports an actionable non-retryable diagnostic when unavailable", () => {
    const root = temporaryDirectory();
    expect(() =>
      resolveLocalWorkspaceWatchAgentBinary({
        environment: {},
        platform: "linux",
        architecture: "x64",
        searchFrom: [root],
      }),
    ).toThrow(LocalWorkspaceWatchAgentUnavailableError);
  });

  it("rejects platform and architecture combinations without a release artifact", () => {
    expect(() =>
      resolveLocalWorkspaceWatchAgentBinary({
        environment: {},
        platform: "win32",
        architecture: "arm64",
        searchFrom: [],
      }),
    ).toThrow("does not support win32/arm64");
  });

  it("classifies a protocol mismatch as permanently unavailable with a bounded probe", () => {
    const probe = vi.fn(() => ({
      status: 0,
      stdout: "bigbud-remote-agent\t0.1.0\t99\t1\tdigest\tlinux\tx86_64\n",
      stderr: "",
    }));

    expect(() => verifyLocalWorkspaceWatchAgentBinary("/tmp/agent", "linux", "x64", probe)).toThrow(
      LocalWorkspaceWatchAgentUnavailableError,
    );
    expect(probe).toHaveBeenCalledWith(
      "/tmp/agent",
      ["--check"],
      expect.objectContaining({ timeout: 5_000, maxBuffer: 64 * 1024 }),
    );
  });

  it("classifies a spawn failure without stdout as permanently unavailable", () => {
    const probe = vi.fn(() => ({
      status: null,
      stdout: undefined,
      stderr: "",
      error: new Error("spawn ENOENT"),
    }));

    expect(() =>
      verifyLocalWorkspaceWatchAgentBinary("/tmp/missing-agent", "linux", "x64", probe),
    ).toThrow(LocalWorkspaceWatchAgentUnavailableError);
  });

  it("maps Node's Darwin identity to Rust's macOS identity", () => {
    const probe = vi.fn(() => ({
      status: 0,
      stdout: "bigbud-remote-agent\t0.1.0\t1\t1\tdigest\tmacos\taarch64\n",
      stderr: "",
    }));

    expect(() =>
      verifyLocalWorkspaceWatchAgentBinary("/tmp/agent", "darwin", "arm64", probe),
    ).not.toThrow();
  });
});
