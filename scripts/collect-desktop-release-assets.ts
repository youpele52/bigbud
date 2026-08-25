#!/usr/bin/env node

import { collectDesktopReleaseAssets } from "./lib/release-assets.ts";
import type { ReleaseMetadata } from "./lib/release-metadata.ts";

const [sourceDirectory, destinationDirectory, platform, architecture, updateChannel] =
  process.argv.slice(2);
if (
  !sourceDirectory ||
  !destinationDirectory ||
  !platform ||
  !architecture ||
  !updateChannel ||
  !["mac", "linux", "win"].includes(platform) ||
  !["latest", "beta", "preview", "nightly"].includes(updateChannel)
) {
  throw new Error(
    "Usage: node scripts/collect-desktop-release-assets.ts <source> <destination> <mac|linux|win> <arch> <latest|beta|preview|nightly>",
  );
}

const copied = collectDesktopReleaseAssets({
  architecture,
  destinationDirectory,
  platform: platform as "mac" | "linux" | "win",
  sourceDirectory,
  updateChannel: updateChannel as ReleaseMetadata["updateChannel"],
});
console.log(`Collected ${copied.length} desktop release assets.`);
