import { Effect, FileSystem, Path } from "effect";
import { ChildProcess } from "effect/unstable/process";

import { resolveCatalogDependencies } from "../resolve-catalog.ts";
import {
  AzureTrustedSigningOptionsConfig,
  BuildScriptError,
  ProductionLinuxIconSource,
  ProductionMacIconSource,
  ProductionWindowsIconSource,
  commandOutputOptions,
  runCommand,
  type BuildPlatform,
} from "./shared.ts";

function generateMacIconSet(
  sourcePng: string,
  targetIcns: string,
  tmpRoot: string,
  path: Path.Path,
  verbose: boolean,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const iconsetDir = path.join(tmpRoot, "icon.iconset");
    yield* fs.makeDirectory(iconsetDir, { recursive: true });

    const iconSizes = [16, 32, 128, 256, 512] as const;
    for (const size of iconSizes) {
      yield* runCommand(
        ChildProcess.make({
          ...commandOutputOptions(verbose),
        })`sips -z ${size} ${size} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}.png`)}`,
      );

      const retinaSize = size * 2;
      yield* runCommand(
        ChildProcess.make({
          ...commandOutputOptions(verbose),
        })`sips -z ${retinaSize} ${retinaSize} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}@2x.png`)}`,
      );
    }

    yield* runCommand(
      ChildProcess.make({
        ...commandOutputOptions(verbose),
      })`iconutil -c icns ${iconsetDir} -o ${targetIcns}`,
    );
  });
}

function stageMacIcons(stageResourcesDir: string, verbose: boolean) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const iconSource = yield* ProductionMacIconSource;
    if (!(yield* fs.exists(iconSource))) {
      return yield* new BuildScriptError({
        message: `Production icon source is missing at ${iconSource}`,
      });
    }

    const tmpRoot = yield* fs.makeTempDirectoryScoped({ prefix: "bigbud-icon-build-" });
    const iconPngPath = path.join(stageResourcesDir, "icon.png");
    const iconIcnsPath = path.join(stageResourcesDir, "icon.icns");

    yield* runCommand(
      ChildProcess.make({
        ...commandOutputOptions(verbose),
      })`sips -z 512 512 ${iconSource} --out ${iconPngPath}`,
    );

    yield* generateMacIconSet(iconSource, iconIcnsPath, tmpRoot, path, verbose);
  });
}

function stageLinuxIcons(stageResourcesDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const iconSource = yield* ProductionLinuxIconSource;
    if (!(yield* fs.exists(iconSource))) {
      return yield* new BuildScriptError({
        message: `Production icon source is missing at ${iconSource}`,
      });
    }

    yield* fs.copyFile(iconSource, path.join(stageResourcesDir, "icon.png"));
  });
}

function stageWindowsIcons(stageResourcesDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const iconSource = yield* ProductionWindowsIconSource;
    if (!(yield* fs.exists(iconSource))) {
      return yield* new BuildScriptError({
        message: `Production Windows icon source is missing at ${iconSource}`,
      });
    }

    yield* fs.copyFile(iconSource, path.join(stageResourcesDir, "icon.ico"));
  });
}

export function validateBundledClientAssets(clientDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const indexPath = path.join(clientDir, "index.html");
    const indexHtml = yield* fs.readFileString(indexPath);
    const refs = [...indexHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
    const missing: string[] = [];

    for (const ref of refs) {
      const normalizedRef = ref.split("#")[0]?.split("?")[0] ?? "";
      if (!normalizedRef) continue;
      if (normalizedRef.startsWith("http://") || normalizedRef.startsWith("https://")) continue;
      if (normalizedRef.startsWith("data:") || normalizedRef.startsWith("mailto:")) continue;

      const ext = path.extname(normalizedRef);
      if (!ext) continue;

      const assetPath = path.join(clientDir, normalizedRef.replace(/^\/+/, ""));
      if (!(yield* fs.exists(assetPath))) {
        missing.push(normalizedRef);
      }
    }

    if (missing.length > 0) {
      const preview = missing.slice(0, 6).join(", ");
      const suffix = missing.length > 6 ? ` (+${missing.length - 6} more)` : "";
      return yield* new BuildScriptError({
        message: `Bundled client references missing files in ${indexPath}: ${preview}${suffix}. Rebuild web/server artifacts.`,
      });
    }
  });
}

export function resolveDesktopRuntimeDependencies(
  dependencies: Record<string, unknown> | undefined,
  catalog: Record<string, unknown>,
): Record<string, unknown> {
  if (!dependencies || Object.keys(dependencies).length === 0) {
    return {};
  }

  return resolveCatalogDependencies(
    Object.fromEntries(
      Object.entries(dependencies).filter(([dependencyName]) => dependencyName !== "electron"),
    ),
    catalog,
    "apps/desktop",
  );
}

function resolveGitHubPublishConfig():
  | {
      readonly provider: "github";
      readonly owner: string;
      readonly repo: string;
      readonly releaseType: "release";
    }
  | undefined {
  const rawRepo =
    process.env.BIGBUD_DESKTOP_UPDATE_REPOSITORY?.trim() ||
    process.env.T3CODE_DESKTOP_UPDATE_REPOSITORY?.trim() ||
    process.env.GITHUB_REPOSITORY?.trim() ||
    "";
  if (!rawRepo) return undefined;

  const [owner, repo, ...rest] = rawRepo.split("/");
  if (!owner || !repo || rest.length > 0) return undefined;

  return { provider: "github", owner, repo, releaseType: "release" };
}

export const createBuildConfig = Effect.fn("createBuildConfig")(function* (
  platform: typeof BuildPlatform.Type,
  target: string,
  productName: string,
  signed: boolean,
  mockUpdates: boolean,
  mockUpdateServerPort: string | undefined,
) {
  const buildConfig: Record<string, unknown> = {
    appId: "ai.bigbud.desktop",
    productName,
    artifactName: "bigbud-${version}-${arch}.${ext}",
    directories: {
      buildResources: "apps/desktop/resources",
    },
    // Native .node addons cannot be loaded from inside an asar archive.
    // These packages must be unpacked to app.asar.unpacked/ at build time.
    asarUnpack: [
      "**/node_modules/node-pty/**",
      "**/node_modules/@github/copilot/prebuilds/**",
      "**/node_modules/@github/copilot/clipboard/**",
      "**/node_modules/@msgpackr-extract/**",
    ],
    // child_process.spawn cannot execute scripts from inside an asar archive.
    // Place the full packaged server runtime outside the asar so the backend child
    // process can be spawned with its own resolvable node_modules tree.
    extraResources: [
      {
        from: "apps/server",
        to: "server",
      },
    ],
  };

  const publishConfig = resolveGitHubPublishConfig();
  if (publishConfig) {
    buildConfig.publish = [publishConfig];
  } else if (mockUpdates) {
    buildConfig.publish = [
      {
        provider: "generic",
        url: `http://localhost:${mockUpdateServerPort ?? 3000}`,
      },
    ];
  }

  if (platform === "mac") {
    buildConfig.mac = {
      target: target === "dmg" ? [target, "zip"] : [target],
      icon: "icon.icns",
      category: "public.app-category.developer-tools",
      // Entitlements grant microphone access (audio-input) and the standard
      // Electron-required sandbox capabilities for signed/notarized builds.
      entitlements: "entitlements.mac.plist",
      entitlementsInherit: "entitlements.mac.plist",
    };
  }

  if (platform === "linux") {
    buildConfig.linux = {
      target: [target],
      executableName: "bigbud",
      icon: "icon.png",
      category: "Development",
      desktop: {
        entry: {
          StartupWMClass: "bigbud",
        },
      },
    };
  }

  if (platform === "win") {
    const winConfig: Record<string, unknown> = {
      target: [target],
      icon: "icon.ico",
    };
    if (signed) {
      winConfig.azureSignOptions = yield* AzureTrustedSigningOptionsConfig;
    }
    buildConfig.win = winConfig;
  }

  return buildConfig;
});

export const assertPlatformBuildResources = Effect.fn("assertPlatformBuildResources")(function* (
  platform: typeof BuildPlatform.Type,
  stageResourcesDir: string,
  verbose: boolean,
) {
  if (platform === "mac") {
    yield* stageMacIcons(stageResourcesDir, verbose);
    return;
  }

  if (platform === "linux") {
    yield* stageLinuxIcons(stageResourcesDir);
    return;
  }

  if (platform === "win") {
    yield* stageWindowsIcons(stageResourcesDir);
  }
});
