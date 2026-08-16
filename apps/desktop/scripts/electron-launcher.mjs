import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DISPLAY_NAME = "bigbud";
const DEV_APP_DISPLAY_NAME = "bigbud (Dev)";
const APP_BUNDLE_ID = "ai.bigbud.desktop";
const DEV_APP_BUNDLE_ID = "ai.bigbud.desktop.dev";
const LAUNCHER_VERSION = 4;

const __dirname = dirname(fileURLToPath(import.meta.url));
export const desktopDir = resolve(__dirname, "..");

function setPlistString(plistPath, key, value) {
  const replaceResult = spawnSync("plutil", ["-replace", key, "-string", value, plistPath], {
    encoding: "utf8",
  });
  if (replaceResult.status === 0) {
    return;
  }

  const insertResult = spawnSync("plutil", ["-insert", key, "-string", value, plistPath], {
    encoding: "utf8",
  });
  if (insertResult.status === 0) {
    return;
  }

  const details = [replaceResult.stderr, insertResult.stderr].filter(Boolean).join("\n");
  throw new Error(`Failed to update plist key "${key}" at ${plistPath}: ${details}`.trim());
}

function patchMainBundleInfoPlist(appBundlePath, iconPath, appBundleId, appDisplayName) {
  const infoPlistPath = join(appBundlePath, "Contents", "Info.plist");
  setPlistString(infoPlistPath, "CFBundleDisplayName", appDisplayName);
  setPlistString(infoPlistPath, "CFBundleName", appDisplayName);
  setPlistString(infoPlistPath, "CFBundleIdentifier", appBundleId);
  setPlistString(infoPlistPath, "CFBundleIconFile", "icon.icns");

  const resourcesDir = join(appBundlePath, "Contents", "Resources");
  copyFileSync(iconPath, join(resourcesDir, "icon.icns"));
  copyFileSync(iconPath, join(resourcesDir, "electron.icns"));
}

function patchHelperBundleInfoPlists(appBundlePath, appBundleId, appDisplayName) {
  const frameworksDir = join(appBundlePath, "Contents", "Frameworks");
  if (!existsSync(frameworksDir)) {
    return;
  }

  for (const entry of readdirSync(frameworksDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".app")) {
      continue;
    }
    if (!entry.name.startsWith("Electron Helper")) {
      continue;
    }

    const helperPlistPath = join(frameworksDir, entry.name, "Contents", "Info.plist");
    if (!existsSync(helperPlistPath)) {
      continue;
    }

    const suffix = entry.name.replace("Electron Helper", "").replace(".app", "").trim();
    const helperName = suffix ? `${appDisplayName} Helper ${suffix}` : `${appDisplayName} Helper`;
    const helperIdSuffix = suffix.replace(/[()]/g, "").trim().toLowerCase().replace(/\s+/g, "-");
    const helperBundleId = helperIdSuffix
      ? `${appBundleId}.helper.${helperIdSuffix}`
      : `${appBundleId}.helper`;

    setPlistString(helperPlistPath, "CFBundleDisplayName", helperName);
    setPlistString(helperPlistPath, "CFBundleName", helperName);
    setPlistString(helperPlistPath, "CFBundleIdentifier", helperBundleId);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function runIconCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status === 0) {
    return;
  }

  throw new Error(
    `Failed to run ${command} ${args.join(" ")}: ${result.stderr || result.stdout || "unknown error"}`.trim(),
  );
}

function generateMacIconSetFromPng(sourcePngPath, targetIcnsPath, runtimeDir) {
  const iconsetDir = join(runtimeDir, "icon.iconset");
  rmSync(iconsetDir, { recursive: true, force: true });
  mkdirSync(iconsetDir, { recursive: true });

  const iconSizes = [16, 32, 128, 256, 512];
  for (const size of iconSizes) {
    runIconCommand("sips", [
      "-z",
      String(size),
      String(size),
      sourcePngPath,
      "--out",
      join(iconsetDir, `icon_${size}x${size}.png`),
    ]);

    const retinaSize = size * 2;
    runIconCommand("sips", [
      "-z",
      String(retinaSize),
      String(retinaSize),
      sourcePngPath,
      "--out",
      join(iconsetDir, `icon_${size}x${size}@2x.png`),
    ]);
  }

  runIconCommand("iconutil", ["-c", "icns", iconsetDir, "-o", targetIcnsPath]);
}

function resolveMacLauncherIcon(isDevelopment, runtimeDir) {
  if (!isDevelopment) {
    return join(desktopDir, "resources", "icon.icns");
  }

  const developmentIconSource = resolve(desktopDir, "../../assets/dev/blueprint-macos-1024.png");
  const generatedDevelopmentIconPath = join(runtimeDir, "icon-dev.icns");
  generateMacIconSetFromPng(developmentIconSource, generatedDevelopmentIconPath, runtimeDir);
  return generatedDevelopmentIconPath;
}

function buildMacLauncher(electronBinaryPath, isDevelopment = false) {
  const sourceAppBundlePath = resolve(electronBinaryPath, "../../..");
  const runtimeDir = join(desktopDir, ".electron-runtime");
  const targetAppBundlePath = join(
    runtimeDir,
    isDevelopment ? `${APP_DISPLAY_NAME}-dev.app` : `${APP_DISPLAY_NAME}.app`,
  );
  const targetBinaryPath = join(targetAppBundlePath, "Contents", "MacOS", "Electron");
  const metadataPath = join(runtimeDir, "metadata.json");
  const iconPath = resolveMacLauncherIcon(isDevelopment, runtimeDir);

  mkdirSync(runtimeDir, { recursive: true });
  // Remove legacy app bundles from previous naming schemes.
  for (const legacyAppName of [
    "T3 Code (Dev).app",
    "T3 Code (Alpha).app",
    "bigbud (Dev).app",
    "bigbud (Beta).app",
  ]) {
    rmSync(join(runtimeDir, legacyAppName), { recursive: true, force: true });
  }

  const expectedMetadata = {
    launcherVersion: LAUNCHER_VERSION,
    isDevelopment,
    sourceAppBundlePath,
    sourceAppMtimeMs: statSync(sourceAppBundlePath).mtimeMs,
    iconMtimeMs: statSync(iconPath).mtimeMs,
  };

  const currentMetadata = readJson(metadataPath);
  if (
    existsSync(targetBinaryPath) &&
    currentMetadata &&
    JSON.stringify(currentMetadata) === JSON.stringify(expectedMetadata)
  ) {
    return targetBinaryPath;
  }

  rmSync(targetAppBundlePath, { recursive: true, force: true });
  // Electron frameworks use relative symlinks within the app bundle. The
  // default cpSync behavior rewrites them to absolute paths into node_modules,
  // which invalidates the copied bundle for macOS code signing.
  cpSync(sourceAppBundlePath, targetAppBundlePath, {
    recursive: true,
    verbatimSymlinks: true,
  });
  const appBundleId = isDevelopment ? DEV_APP_BUNDLE_ID : APP_BUNDLE_ID;
  const appDisplayName = isDevelopment ? DEV_APP_DISPLAY_NAME : APP_DISPLAY_NAME;
  patchMainBundleInfoPlist(targetAppBundlePath, iconPath, appBundleId, appDisplayName);
  patchHelperBundleInfoPlists(targetAppBundlePath, appBundleId, appDisplayName);
  runIconCommand("codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    "--identifier",
    appBundleId,
    targetAppBundlePath,
  ]);
  writeFileSync(metadataPath, `${JSON.stringify(expectedMetadata, null, 2)}\n`);

  return targetBinaryPath;
}

/**
 * Resolve a development launch that macOS records as an application launch.
 *
 * Executing Contents/MacOS/Electron directly bypasses Launch Services, which
 * prevents the generated dev bundle from behaving like a normal macOS app in
 * the app switcher and recent-app surfaces. `open -W` keeps a waitable child
 * for the dev watcher, while `--env` preserves the shell environment that the
 * previous direct spawn passed to Electron.
 */
export function resolveDevelopmentElectronLaunch(appArguments, environment) {
  const electronBinaryPath = resolveElectronPath(true);
  if (process.platform !== "darwin") {
    return { command: electronBinaryPath, args: appArguments };
  }

  const appBundlePath = resolve(electronBinaryPath, "../../..");
  const runtimeDir = dirname(appBundlePath);
  const stdoutPath = join(runtimeDir, "dev.stdout.log");
  const stderrPath = join(runtimeDir, "dev.stderr.log");
  writeFileSync(stdoutPath, "", { mode: 0o600 });
  writeFileSync(stderrPath, "", { mode: 0o600 });
  const args = ["-n", "-F", "-W", "-o", stdoutPath, "--stderr", stderrPath];
  for (const [key, value] of Object.entries(environment).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      typeof value === "string" &&
      /^[A-Za-z][A-Za-z0-9_]*$/.test(key) &&
      key !== "ELECTRON_RUN_AS_NODE"
    ) {
      args.push("--env", `${key}=${value}`);
    }
  }
  args.push(appBundlePath, "--args", ...appArguments);

  return { command: "/usr/bin/open", args, logPaths: [stdoutPath, stderrPath] };
}

export function resolveElectronPath(isDevelopment = false) {
  const require = createRequire(import.meta.url);
  const electronBinaryPath = require("electron");

  if (process.platform !== "darwin") {
    return electronBinaryPath;
  }

  return buildMacLauncher(electronBinaryPath, isDevelopment);
}
