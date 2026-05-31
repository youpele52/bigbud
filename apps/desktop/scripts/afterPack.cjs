const fs = require("node:fs");
const path = require("node:path");

/**
 * electron-builder afterPack hook.
 *
 * Linux AppImages mount their AppDir read-only at runtime, so package the
 * backend's node_modules symlink before the AppImage filesystem is sealed.
 */
module.exports = async function afterPack(context) {
  const platformName =
    typeof context.electronPlatformName === "string"
      ? context.electronPlatformName
      : context.electronPlatformName?.name;

  if (platformName !== "linux") {
    return;
  }

  const serverDir = path.join(context.appOutDir, "resources", "server");
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
};
