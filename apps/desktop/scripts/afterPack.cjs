const {
  assertPackagedBundledSkills,
  ensureLinuxBackendModulesSymlink,
  resolvePackagedServerDir,
} = require("./afterPack.shared.cjs");

/**
 * electron-builder afterPack hook.
 *
 * Validates packaged native skills on every platform. On Linux, it also creates
 * the backend's node_modules symlink before the AppImage filesystem is sealed.
 */
module.exports = async function afterPack(context) {
  const platformName =
    typeof context.electronPlatformName === "string"
      ? context.electronPlatformName
      : context.electronPlatformName?.name;
  const serverDir = resolvePackagedServerDir(context);

  assertPackagedBundledSkills(serverDir);
  console.log(`[afterPack] Verified bundled native skills at ${serverDir}.`);

  if (platformName === "linux") {
    ensureLinuxBackendModulesSymlink(serverDir);
  }
};
