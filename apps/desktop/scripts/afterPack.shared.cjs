const fs = require("node:fs");
const path = require("node:path");

const REQUIRED_BUNDLED_SKILL_NAMES = ["automation", "git-commit", "handoff", "teach"];

function resolvePackagedServerDir(context) {
  const platformName =
    typeof context.electronPlatformName === "string"
      ? context.electronPlatformName
      : context.electronPlatformName?.name;

  if (platformName === "darwin") {
    const appName = context.packager?.appInfo?.productFilename;
    if (!appName) {
      throw new Error("[afterPack] Missing packager.appInfo.productFilename for macOS package.");
    }
    return path.join(context.appOutDir, `${appName}.app`, "Contents", "Resources", "server");
  }

  return path.join(context.appOutDir, "resources", "server");
}

function assertPackagedBundledSkills(serverDir) {
  const bundledSkillsDir = path.join(serverDir, "bundled-skills");
  const missingSkillFiles = REQUIRED_BUNDLED_SKILL_NAMES.filter(
    (skillName) => !fs.existsSync(path.join(bundledSkillsDir, skillName, "SKILL.md")),
  ).map((skillName) => `${skillName}/SKILL.md`);

  if (missingSkillFiles.length > 0) {
    throw new Error(
      `[afterPack] Missing bundled native skills in ${bundledSkillsDir}: ${missingSkillFiles.join(", ")}`,
    );
  }
}

function ensureLinuxBackendModulesSymlink(serverDir) {
  const modulesDir = path.join(serverDir, "_modules");
  const nodeModulesPath = path.join(serverDir, "node_modules");

  if (!fs.existsSync(modulesDir)) {
    console.warn(`[afterPack] Backend _modules directory not found at ${modulesDir}`);
    return;
  }

  try {
    const stat = fs.lstatSync(nodeModulesPath);
    if (stat.isSymbolicLink()) {
      console.log("[afterPack] Backend node_modules symlink already present.");
      return;
    }
    fs.rmSync(nodeModulesPath, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  fs.symlinkSync("_modules", nodeModulesPath, "dir");
  console.log("[afterPack] Created backend node_modules symlink for Linux package.");
}

module.exports = {
  REQUIRED_BUNDLED_SKILL_NAMES,
  resolvePackagedServerDir,
  assertPackagedBundledSkills,
  ensureLinuxBackendModulesSymlink,
};
