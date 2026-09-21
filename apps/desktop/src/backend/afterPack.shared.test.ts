import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { assert, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const afterPackShared = require("../../scripts/afterPack.shared.cjs") as {
  assertPackagedBundledSkills: (serverDir: string) => void;
  assertPackagedDesktopSupervisor: (serverDir: string, platformName: string) => void;
  ensurePosixBackendModulesSymlink: (serverDir: string) => void;
  shouldEnsurePosixBackendModulesSymlink: (platformName: string) => boolean;
  resolvePackagedServerDir: (context: {
    electronPlatformName: string;
    appOutDir: string;
    packager?: { appInfo?: { productFilename?: string } };
  }) => string;
};

const REQUIRED_SKILL_NAMES = ["automation", "git-commit", "handoff", "teach"] as const;

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeSkillFixture(serverDir: string, skillName: string) {
  const skillDir = join(serverDir, "bundled-skills", skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `# ${skillName}\n`);
}

describe("afterPack.shared", () => {
  it.each([
    ["darwin", true],
    ["linux", true],
    ["win32", false],
  ] as const)("uses the POSIX link hook only for %s", (platformName, expected) => {
    assert.equal(afterPackShared.shouldEnsurePosixBackendModulesSymlink(platformName), expected);
  });

  it("resolves the packaged server directory for macOS", () => {
    const resolved = afterPackShared.resolvePackagedServerDir({
      electronPlatformName: "darwin",
      appOutDir: "/tmp/dist/mac-arm64",
      packager: { appInfo: { productFilename: "bigbud" } },
    });

    assert.equal(resolved, "/tmp/dist/mac-arm64/bigbud.app/Contents/Resources/server");
  });

  it("resolves the packaged server directory for Windows and Linux", () => {
    assert.equal(
      afterPackShared.resolvePackagedServerDir({
        electronPlatformName: "win32",
        appOutDir: "C:\\tmp\\win-unpacked",
      }),
      "C:\\tmp\\win-unpacked/resources/server",
    );
    assert.equal(
      afterPackShared.resolvePackagedServerDir({
        electronPlatformName: "linux",
        appOutDir: "/tmp/linux-unpacked",
      }),
      "/tmp/linux-unpacked/resources/server",
    );
  });

  it("fails when packaged bundled skills are missing", () => {
    const serverDir = makeTempDir("after-pack-server-");
    try {
      for (const skillName of REQUIRED_SKILL_NAMES.filter((name) => name !== "teach")) {
        writeSkillFixture(serverDir, skillName);
      }

      assert.throws(
        () => afterPackShared.assertPackagedBundledSkills(serverDir),
        /teach\/SKILL\.md/,
      );
    } finally {
      rmSync(serverDir, { recursive: true, force: true });
    }
  });

  it("requires the executable and release evidence for the packaged supervisor", () => {
    const serverDir = makeTempDir("after-pack-supervisor-");
    const supervisorDir = join(serverDir, "delivery-supervisor", "bin");
    try {
      mkdirSync(supervisorDir, { recursive: true });
      const binaryPath = join(supervisorDir, "bigbud-desktop-supervisor");
      writeFileSync(binaryPath, "fixture");
      chmodSync(binaryPath, 0o755);
      writeFileSync(join(supervisorDir, "artifact-manifest.json"), "{}");
      expect(() => afterPackShared.assertPackagedDesktopSupervisor(serverDir, "linux")).toThrow(
        /sbom\.cdx\.json/,
      );
      writeFileSync(join(supervisorDir, "sbom.cdx.json"), "{}");
      expect(() =>
        afterPackShared.assertPackagedDesktopSupervisor(serverDir, "linux"),
      ).not.toThrow();
    } finally {
      rmSync(serverDir, { recursive: true, force: true });
    }
  });

  it("creates the macOS backend node_modules symlink when missing", () => {
    const serverDir = makeTempDir("after-pack-darwin-server-");
    try {
      mkdirSync(join(serverDir, "_modules"), { recursive: true });
      afterPackShared.ensurePosixBackendModulesSymlink(serverDir);

      const linkPath = join(serverDir, "node_modules");
      assert.equal(readlinkSync(linkPath), "_modules");
    } finally {
      rmSync(serverDir, { recursive: true, force: true });
    }
  });

  it("preserves a valid existing Linux backend node_modules symlink", () => {
    const serverDir = makeTempDir("after-pack-linux-server-");
    try {
      mkdirSync(join(serverDir, "_modules"), { recursive: true });
      symlinkSync("_modules", join(serverDir, "node_modules"), "dir");
      afterPackShared.ensurePosixBackendModulesSymlink(serverDir);

      const linkPath = join(serverDir, "node_modules");
      assert.equal(readlinkSync(linkPath), "_modules");
    } finally {
      rmSync(serverDir, { recursive: true, force: true });
    }
  });

  it("fails when the packaged _modules directory is missing", () => {
    const serverDir = makeTempDir("after-pack-missing-modules-");
    try {
      expect(() => afterPackShared.ensurePosixBackendModulesSymlink(serverDir)).toThrow(
        /_modules directory is missing/,
      );
    } finally {
      rmSync(serverDir, { recursive: true, force: true });
    }
  });

  it("fails when packaged _modules is not a directory", () => {
    const serverDir = makeTempDir("after-pack-invalid-modules-");
    try {
      writeFileSync(join(serverDir, "_modules"), "unexpected");
      expect(() => afterPackShared.ensurePosixBackendModulesSymlink(serverDir)).toThrow(
        /_modules is not a directory/,
      );
    } finally {
      rmSync(serverDir, { recursive: true, force: true });
    }
  });

  it("fails and preserves a wrong packaged symlink target", () => {
    const serverDir = makeTempDir("after-pack-wrong-target-");
    try {
      mkdirSync(join(serverDir, "_modules"));
      mkdirSync(join(serverDir, "other-modules"));
      symlinkSync("other-modules", join(serverDir, "node_modules"), "dir");

      expect(() => afterPackShared.ensurePosixBackendModulesSymlink(serverDir)).toThrow(
        /must target exactly _modules/,
      );
      assert.equal(readlinkSync(join(serverDir, "node_modules")), "other-modules");
    } finally {
      rmSync(serverDir, { recursive: true, force: true });
    }
  });

  it.each(["file", "directory"] as const)(
    "fails and preserves an unexpected packaged %s",
    (kind) => {
      const serverDir = makeTempDir(`after-pack-unexpected-${kind}-`);
      try {
        mkdirSync(join(serverDir, "_modules"));
        const nodeModulesPath = join(serverDir, "node_modules");
        if (kind === "file") writeFileSync(nodeModulesPath, "unexpected");
        else mkdirSync(nodeModulesPath);

        expect(() => afterPackShared.ensurePosixBackendModulesSymlink(serverDir)).toThrow(
          /must be a symlink/,
        );
        assert.equal(lstatSync(nodeModulesPath).isDirectory(), kind === "directory");
        assert.equal(lstatSync(nodeModulesPath).isFile(), kind === "file");
      } finally {
        rmSync(serverDir, { recursive: true, force: true });
      }
    },
  );
});
