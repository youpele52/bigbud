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

function assertPackagedDesktopSupervisor(serverDir, platformName) {
  const binaryName =
    platformName === "win32" ? "bigbud-desktop-supervisor.exe" : "bigbud-desktop-supervisor";
  const supervisorDir = path.join(serverDir, "delivery-supervisor", "bin");
  const requiredFiles = [binaryName, "artifact-manifest.json", "sbom.cdx.json"];
  const missingFiles = requiredFiles.filter(
    (name) => !fs.existsSync(path.join(supervisorDir, name)),
  );
  if (missingFiles.length > 0) {
    throw new Error(
      `[afterPack] Missing desktop delivery supervisor files in ${supervisorDir}: ${missingFiles.join(", ")}`,
    );
  }
  if (platformName !== "win32") {
    fs.accessSync(path.join(supervisorDir, binaryName), fs.constants.X_OK);
  }
}

/**
 * Create and verify the POSIX backend module link before electron-builder
 * signs macOS bundles or seals Linux AppImages. Unexpected packaged content is
 * a build error: deleting it here could hide a broken or tampered artifact.
 */
function ensurePosixBackendModulesSymlink(serverDir) {
  const modulesDir = path.join(serverDir, "_modules");
  const nodeModulesPath = path.join(serverDir, "node_modules");

  let modulesStat;
  try {
    modulesStat = fs.lstatSync(modulesDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`[afterPack] Backend _modules directory is missing at ${modulesDir}`, {
        cause: error,
      });
    }
    throw error;
  }
  if (!modulesStat.isDirectory()) {
    throw new Error(`[afterPack] Backend _modules is not a directory at ${modulesDir}`);
  }

  try {
    const stat = fs.lstatSync(nodeModulesPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(
        `[afterPack] Backend node_modules must be a symlink to _modules, found packaged content at ${nodeModulesPath}`,
      );
    }
    const target = fs.readlinkSync(nodeModulesPath);
    if (target !== "_modules") {
      throw new Error(
        `[afterPack] Backend node_modules symlink must target exactly _modules, found ${target}`,
      );
    }
    console.log("[afterPack] Backend node_modules symlink already valid.");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    fs.symlinkSync("_modules", nodeModulesPath, "dir");
    console.log("[afterPack] Created backend node_modules symlink for POSIX package.");
  }

  const finalStat = fs.lstatSync(nodeModulesPath);
  if (!finalStat.isSymbolicLink() || fs.readlinkSync(nodeModulesPath) !== "_modules") {
    throw new Error(`[afterPack] Final backend node_modules symlink verification failed.`);
  }
}

function shouldEnsurePosixBackendModulesSymlink(platformName) {
  return platformName === "darwin" || platformName === "linux";
}

module.exports = {
  REQUIRED_BUNDLED_SKILL_NAMES,
  resolvePackagedServerDir,
  assertPackagedBundledSkills,
  assertPackagedDesktopSupervisor,
  ensurePosixBackendModulesSymlink,
  shouldEnsurePosixBackendModulesSymlink,
};
