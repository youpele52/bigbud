const { notarize } = require("@electron/notarize");
const { execSync } = require("node:child_process");
const path = require("node:path");

/**
 * electron-builder afterSign hook.
 *
 * Submits the signed .app to Apple for notarization, staples the resulting
 * ticket, and validates the staple before the DMG/ZIP is created.
 *
 * This script is invoked from a staged temp directory, so it resolves
 * @electron/notarize via NODE_PATH pointing back to the monorepo.
 */
module.exports = async function afterSign(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== "darwin") {
    console.log("[afterSign] Skipping notarization: not macOS");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.log(
      "[afterSign] Skipping notarization: missing APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, or APPLE_TEAM_ID",
    );
    return;
  }

  console.log(`[afterSign] Notarizing ${appPath}...`);

  await notarize({
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });

  console.log("[afterSign] Stapling ticket...");
  execSync(`xcrun stapler staple "${appPath}"`, { stdio: "inherit" });

  console.log("[afterSign] Validating staple...");
  execSync(`xcrun stapler validate "${appPath}"`, { stdio: "inherit" });

  console.log("[afterSign] Notarization complete.");
};
