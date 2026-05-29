const fs = require("node:fs");
const path = require("node:path");

/**
 * Required Electron runtime files for Linux that must be present in the
 * packaged app directory. These are core V8/ICU binaries.
 */
const REQUIRED_FILES = ["snapshot_blob.bin", "v8_context_snapshot.bin", "icudtl.dat"];

/**
 * electron-builder afterExtract hook.
 *
 * Copies missing required Electron runtime files from the Electron distribution
 * into the packaged app output directory. This is a safety net for cases where
 * electron-builder omits these files during extraction (observed with Electron 40
 * and certain electron-builder version combinations on Linux).
 *
 * @param {object} context
 * @param {string} context.appOutDir - Directory where the app was extracted
 * @param {string} context.electronVersion - Version of Electron being packaged
 * @param {string} context.platform - Target platform name
 * @param {string} context.arch - Target architecture
 */
module.exports = async function afterExtract(context) {
  const { appOutDir, platform } = context;

  if (platform.name !== "linux") {
    return;
  }

  const missing = [];
  for (const file of REQUIRED_FILES) {
    const filePath = path.join(appOutDir, file);
    if (!fs.existsSync(filePath)) {
      missing.push(file);
    }
  }

  if (missing.length === 0) {
    console.log("[afterExtract] All required Electron runtime files present.");
    return;
  }

  console.warn(`[afterExtract] Missing required files in ${appOutDir}: ${missing.join(", ")}`);

  // Try to locate the Electron distribution source.
  // electron-builder caches downloaded Electron zips; the unpacked directory
  // is the most reliable source on the build host.
  const electronDistCandidates = [process.env.ELECTRON_DIST_PATH].filter(Boolean);

  // Also try common electron-builder cache locations
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (homeDir) {
    electronDistCandidates.push(
      path.join(homeDir, ".cache", "electron", context.electronVersion),
      path.join(homeDir, ".cache", "electron-builder", "electron", context.electronVersion),
    );
  }

  let sourceDir = null;
  for (const candidate of electronDistCandidates) {
    if (fs.existsSync(candidate)) {
      sourceDir = candidate;
      break;
    }
  }

  if (!sourceDir) {
    console.warn("[afterExtract] Could not locate Electron distribution to copy missing files.");
    console.warn(
      "[afterExtract] Set ELECTRON_DIST_PATH to the unpacked Electron directory if needed.",
    );
    return;
  }

  for (const file of missing) {
    const src = path.join(sourceDir, file);
    const dst = path.join(appOutDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      console.log(`[afterExtract] Copied ${file} from ${src} to ${dst}`);
    } else {
      console.warn(`[afterExtract] Source file not found: ${src}`);
    }
  }
};
