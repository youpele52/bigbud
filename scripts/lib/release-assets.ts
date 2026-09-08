import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { ReleaseMetadata } from "./release-metadata";

const DESKTOP_ASSET_EXTENSIONS = [
  ".dmg",
  ".zip",
  ".AppImage",
  ".deb",
  ".exe",
  ".blockmap",
] as const;

export interface CollectDesktopReleaseAssetsOptions {
  readonly architecture: string;
  readonly destinationDirectory: string;
  readonly platform: "mac" | "linux" | "win";
  readonly sourceDirectory: string;
  readonly updateChannel: ReleaseMetadata["updateChannel"];
}

export function collectDesktopReleaseAssets(
  options: CollectDesktopReleaseAssetsOptions,
): readonly string[] {
  mkdirSync(options.destinationDirectory, { recursive: true });
  const copied = readdirSync(options.sourceDirectory)
    .filter(
      (name) =>
        DESKTOP_ASSET_EXTENSIONS.some((extension) => name.endsWith(extension)) ||
        (name.startsWith(options.updateChannel) && name.endsWith(".yml")),
    )
    .map((name) => {
      const destination = join(
        options.destinationDirectory,
        normalizeReleaseAssetName(name, options),
      );
      copyFileSync(join(options.sourceDirectory, name), destination);
      return destination;
    });

  if (options.platform === "linux" && options.architecture === "x64") {
    const manifest = join(options.destinationDirectory, `${options.updateChannel}-linux.yml`);
    if (existsSync(manifest)) {
      const contents = readFileSync(manifest, "utf8").replaceAll(
        "-x86_64.AppImage",
        "-x64.AppImage",
      );
      writeFileSync(manifest, contents);
    }
  }

  if (options.platform === "mac" && options.architecture !== "arm64") {
    const manifest = join(options.destinationDirectory, `${options.updateChannel}-mac.yml`);
    if (!existsSync(manifest)) {
      throw new Error(`Missing macOS update manifest: ${manifest}`);
    }
    const architectureManifest = join(
      options.destinationDirectory,
      `${options.updateChannel}-mac-${options.architecture}.yml`,
    );
    renameSync(manifest, architectureManifest);
    return copied.map((path) => (path === manifest ? architectureManifest : path));
  }

  return copied;
}

function normalizeReleaseAssetName(
  name: string,
  options: Pick<CollectDesktopReleaseAssetsOptions, "architecture" | "platform">,
): string {
  if (options.platform !== "linux" || options.architecture !== "x64") return name;
  return name.replace(/-x86_64(?=\.AppImage$)/, "-x64").replace(/-amd64(?=\.deb$)/, "-x64");
}

export function verifyAssembledDesktopReleaseAssets(
  directory: string,
  updateChannel: ReleaseMetadata["updateChannel"],
): void {
  const names = readdirSync(directory);
  const requiredFiles = [
    "install.sh",
    "install.ps1",
    `${updateChannel}-mac.yml`,
    `${updateChannel}-linux.yml`,
    `${updateChannel}.yml`,
  ];
  for (const name of requiredFiles) {
    if (!names.includes(name)) throw new Error(`Missing assembled release asset: ${name}`);
  }

  const allowedManifests = new Set(requiredFiles.slice(2));
  const unexpectedManifest = names.find(
    (name) =>
      /^(?:latest|beta|preview|nightly)(?:-mac|-linux)?(?:-[^.]+)?\.yml$/.test(name) &&
      !allowedManifests.has(name),
  );
  if (unexpectedManifest) {
    throw new Error(`Unexpected update manifest: ${unexpectedManifest}`);
  }

  const desktopArtifactNames = names.filter((name) => !name.startsWith("server-workspace-agent-"));
  for (const suffix of [
    "-arm64.dmg",
    "-x64.dmg",
    "-arm64.zip",
    "-x64.zip",
    "-x64.AppImage",
    "-x64.deb",
    "-x64.exe",
    "-arm64.zip.blockmap",
    "-x64.zip.blockmap",
    "-x64.exe.blockmap",
  ] as const) {
    if (!desktopArtifactNames.some((name) => name.endsWith(suffix))) {
      throw new Error(`Missing assembled release artifact: *${suffix}`);
    }
  }

  for (const name of [
    "server-workspace-agent-darwin-arm64",
    "server-workspace-agent-darwin-x64",
    "server-workspace-agent-linux-x64",
    "server-workspace-agent-win32-x64.exe",
  ]) {
    if (!names.includes(name)) throw new Error(`Missing packaged workspace agent: ${name}`);
  }

  const manifestRequirements = [
    [`${updateChannel}-mac.yml`, ["-arm64.zip", "-x64.zip"]],
    [`${updateChannel}-linux.yml`, ["-x64.AppImage"]],
    [`${updateChannel}.yml`, ["-x64.exe"]],
  ] as const;
  for (const [name, requiredReferences] of manifestRequirements) {
    const contents = readFileSync(join(directory, name), "utf8");
    for (const reference of requiredReferences) {
      if (!contents.includes(reference)) {
        throw new Error(`Update manifest ${name} does not reference *${reference}`);
      }
    }
  }
}
