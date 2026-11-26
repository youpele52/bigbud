import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertSshOwnerBinary,
  findDesktopSshOwnerTarget,
  verifyInactiveSshOwner,
} from "../packaged-ssh-owner.ts";
import { desktopArtifactCliRuntimeLayer } from "./shared.ts";
import { sshOwnerBuildPlan, stagePackagedSshOwner } from "./sshOwner.ts";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

const mac = findDesktopSshOwnerTarget("mac", "arm64")!;
const windows = findDesktopSshOwnerTarget("win", "x64")!;

function peFixture(machine: number) {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ");
  bytes.writeUInt32LE(64, 60);
  bytes.write("PE\0\0", 64);
  bytes.writeUInt16LE(machine, 68);
  return bytes;
}

describe("desktop SSH owner packaging", () => {
  it("plans native locked release builds for the Mac arm64 and Windows x64 hosts", () => {
    const repoRoot = join(tmpdir(), "repo");
    const macPlan = sshOwnerBuildPlan({
      repoRoot,
      platform: "mac",
      arch: "arm64",
      hostPlatform: "darwin",
      hostArch: "arm64",
    });
    const winPlan = sshOwnerBuildPlan({
      repoRoot,
      platform: "win",
      arch: "x64",
      hostPlatform: "win32",
      hostArch: "x64",
    });
    for (const [plan, name] of [
      [macPlan, "bigbud-ssh-owner"],
      [winPlan, "bigbud-ssh-owner.exe"],
    ] as const) {
      expect(plan?.cargoArgs).toEqual([
        "build",
        "--locked",
        "--release",
        "--package",
        "bigbud-ssh-owner",
      ]);
      expect(plan?.source).toBe(join(repoRoot, "target", "release", name));
      expect(plan?.relativePath).toBe(`ssh-owner/bin/${name}`);
    }
  });

  it("plans the U4 cells (Intel Mac cross build, Linux) but not Windows arm64 or universal", () => {
    const repoRoot = join(tmpdir(), "repo");
    const intel = sshOwnerBuildPlan({
      repoRoot,
      platform: "mac",
      arch: "x64",
      hostPlatform: "darwin",
      hostArch: "arm64",
    });
    expect(intel?.cargoArgs).toContain("x86_64-apple-darwin");
    expect(intel?.source).toBe(
      join(repoRoot, "target", "x86_64-apple-darwin", "release", "bigbud-ssh-owner"),
    );
    for (const arch of ["x64", "arm64"] as const) {
      expect(sshOwnerBuildPlan({ repoRoot, platform: "linux", arch })?.relativePath).toBe(
        "ssh-owner/bin/bigbud-ssh-owner",
      );
    }
    for (const [platform, arch] of [
      ["win", "arm64"],
      ["mac", "universal"],
    ] as const) {
      expect(sshOwnerBuildPlan({ repoRoot, platform, arch })).toBeUndefined();
    }
  });

  it("rejects missing and wrong-target binaries before attempting to launch", () => {
    const root = mkdtempSync(join(tmpdir(), "bigbud-ssh-owner-test-"));
    try {
      const binaryPath = join(root, "bigbud-ssh-owner.exe");
      expect(() => assertSshOwnerBinary(binaryPath, windows)).toThrow(/ENOENT/);
      writeFileSync(binaryPath, peFixture(0xaa64));
      expect(() => assertSshOwnerBinary(binaryPath, windows)).toThrow(/target mismatch/);
      writeFileSync(binaryPath, peFixture(0x8664));
      expect(() => assertSshOwnerBinary(binaryPath, windows)).not.toThrow();
      expect(spawnSync).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires and copies the target binary in skip-build mode before the smoke", async () => {
    const root = mkdtempSync(join(tmpdir(), "bigbud-ssh-owner-stage-test-"));
    try {
      const input = {
        repoRoot: root,
        stageServerDir: join(root, "resources", "server"),
        platform: "win",
        arch: "x64",
        skipBuild: true,
        verbose: false,
      } as const;
      const stage = () =>
        Effect.runPromise(
          stagePackagedSshOwner(input).pipe(
            Effect.provide(desktopArtifactCliRuntimeLayer),
            Effect.scoped,
          ),
        );
      await expect(stage()).rejects.toThrow(/Invalid SSH owner/);
      expect(spawnSync).not.toHaveBeenCalled();

      const plan = sshOwnerBuildPlan(input)!;
      mkdirSync(dirname(plan.source), { recursive: true });
      const bytes = peFixture(0x8664);
      writeFileSync(plan.source, bytes);
      vi.mocked(spawnSync).mockReturnValue({
        pid: 1,
        output: [],
        status: 1,
        signal: null,
        stdout: "",
        stderr: "Windows picker proof owner stopped\r\n",
      });
      await stage();
      const staged = join(input.stageServerDir, "ssh-owner", "bin", "bigbud-ssh-owner.exe");
      expect(readFileSync(staged)).toEqual(bytes);
      expect(spawnSync).toHaveBeenCalledOnce();
      expect(spawnSync).toHaveBeenCalledWith(staged, [], expect.anything());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("smokes the no-argument path with no owner opt-in or input", () => {
    vi.stubEnv("BIGBUD_SSH_OWNER", "1");
    vi.stubEnv("bigbud_ssh_owner_picker_proof", "1");
    vi.mocked(spawnSync).mockReturnValue({
      pid: 1,
      output: [],
      status: 1,
      signal: null,
      stdout: "",
      stderr: "S1 picker proof owner stopped\n",
    });
    verifyInactiveSshOwner("/owner", mac);
    expect(spawnSync).toHaveBeenCalledWith(
      "/owner",
      [],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 }),
    );
    const options = vi.mocked(spawnSync).mock.calls[0]?.[2];
    expect(
      Object.keys(options?.env ?? {}).some((key) =>
        key.toUpperCase().startsWith("BIGBUD_SSH_OWNER"),
      ),
    ).toBe(false);
  });

  it("rejects an executable that does not report fail-closed startup", () => {
    vi.mocked(spawnSync).mockReturnValue({
      pid: 1,
      output: [],
      status: 0,
      signal: null,
      stdout: "",
      stderr: "",
    });
    expect(() => verifyInactiveSshOwner("/owner.exe", windows)).toThrow(
      /did not reject inactive startup/,
    );
  });
});
