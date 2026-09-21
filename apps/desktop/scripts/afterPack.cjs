const {
  assertPackagedBundledSkills,
  assertPackagedDesktopSupervisor,
  ensurePosixBackendModulesSymlink,
  resolvePackagedServerDir,
  shouldEnsurePosixBackendModulesSymlink,
} = require("./afterPack.shared.cjs");

/**
 * electron-builder afterPack hook.
 *
 * Validates packaged native skills on every platform. On macOS and Linux, it
 * creates and verifies the backend's node_modules symlink before signing or
 * sealing the artifact. Windows is intentionally excluded from this POSIX link.
 */
module.exports = async function afterPack(context) {
  const platformName =
    typeof context.electronPlatformName === "string"
      ? context.electronPlatformName
      : context.electronPlatformName?.name;
  const serverDir = resolvePackagedServerDir(context);

  assertPackagedBundledSkills(serverDir);
  assertPackagedDesktopSupervisor(serverDir, platformName);
  console.log(`[afterPack] Verified bundled native skills at ${serverDir}.`);

  if (shouldEnsurePosixBackendModulesSymlink(platformName)) {
    ensurePosixBackendModulesSymlink(serverDir);
  }
};
