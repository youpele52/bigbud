const { runNotarization } = require("./notarize.pipeline.cjs");
const { execFileSync, spawnSync } = require("node:child_process");
const path = require("node:path");

function requireCredential(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`[afterSign] Missing required credential: ${name}`);
  }
  return value;
}

function verifyCodeSignature(target, deep = false) {
  const args = ["--verify", "--strict", "--verbose=2"];
  if (deep) args.push("--deep");
  args.push(target);
  execFileSync("codesign", args, { stdio: "inherit", timeout: 120000 });
}

function verifyTeamIdentifier(target, expectedTeamId) {
  const result = spawnSync("codesign", ["-dv", "--verbose=4", target], {
    encoding: "utf8",
    timeout: 120000,
  });
  if (result.status !== 0) {
    throw new Error(`[afterSign] Could not inspect TeamIdentifier for ${target}`);
  }
  const actualTeamId = /^TeamIdentifier=(.+)$/m.exec(result.stderr)?.[1]?.trim();
  if (!actualTeamId) {
    throw new Error(`[afterSign] Signed target has no TeamIdentifier: ${target}`);
  }
  if (actualTeamId !== expectedTeamId) {
    throw new Error(
      `[afterSign] TeamIdentifier mismatch for ${target}: expected ${expectedTeamId}, received ${actualTeamId}`,
    );
  }
}

/**
 * electron-builder afterSign hook.
 *
 * Submits the signed .app to Apple for notarization, staples the resulting
 * ticket, and validates the staple before the DMG/ZIP is created.
 *
 * The pipeline submits once; only ticket operations may be retried.
 */
module.exports = async function afterSign(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== "darwin") {
    console.log("[afterSign] Skipping notarization: not macOS");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  const appleId = requireCredential("APPLE_ID");
  const appleIdPassword = requireCredential("APPLE_APP_SPECIFIC_PASSWORD");
  const teamId = requireCredential("APPLE_TEAM_ID");
  const sidecarPaths = [
    "Contents/Resources/server/workspace-agent/bin/bigbud-remote-agent",
    "Contents/Resources/server/delivery-supervisor/bin/bigbud-desktop-supervisor",
  ].map((relativePath) => path.join(appPath, relativePath));

  for (const sidecarPath of sidecarPaths) {
    console.log(`[afterSign] Verifying Rust sidecar signature: ${sidecarPath}`);
    verifyCodeSignature(sidecarPath);
    verifyTeamIdentifier(sidecarPath, teamId);
  }
  console.log(`[afterSign] Verifying app signature: ${appPath}`);
  verifyCodeSignature(appPath, true);
  verifyTeamIdentifier(appPath, teamId);

  console.log(`[afterSign] Notarizing ${appPath}...`);

  await runNotarization({
    appPath,
    appleId,
    password: appleIdPassword,
    teamId,
    recoveryDir: process.env.BIGBUD_NOTARIZATION_RECOVERY_DIR,
  });

  console.log("[afterSign] Notarization complete.");
};
