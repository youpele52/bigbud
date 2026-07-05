import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { assert, describe, it } from "vitest";

const require = createRequire(import.meta.url);
const afterPackShared = require("../../scripts/afterPack.shared.cjs") as {
  assertPackagedBundledSkills: (serverDir: string) => void;
  ensureLinuxBackendModulesSymlink: (serverDir: string) => void;
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

  it("creates the Linux backend node_modules symlink when missing", () => {
    const serverDir = makeTempDir("after-pack-linux-server-");
    try {
      mkdirSync(join(serverDir, "_modules"), { recursive: true });
      afterPackShared.ensureLinuxBackendModulesSymlink(serverDir);

      const linkPath = join(serverDir, "node_modules");
      assert.equal(require("node:fs").readlinkSync(linkPath), "_modules");
    } finally {
      rmSync(serverDir, { recursive: true, force: true });
    }
  });

  it("keeps an existing Linux backend node_modules symlink", () => {
    const serverDir = makeTempDir("after-pack-linux-server-");
    try {
      mkdirSync(join(serverDir, "_modules"), { recursive: true });
      symlinkSync("_modules", join(serverDir, "node_modules"), "dir");
      afterPackShared.ensureLinuxBackendModulesSymlink(serverDir);

      const linkPath = join(serverDir, "node_modules");
      assert.equal(require("node:fs").readlinkSync(linkPath), "_modules");
    } finally {
      rmSync(serverDir, { recursive: true, force: true });
    }
  });
});
