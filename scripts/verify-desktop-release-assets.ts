#!/usr/bin/env node

import { verifyAssembledDesktopReleaseAssets } from "./lib/release-assets.ts";
import type { ReleaseMetadata } from "./lib/release-metadata.ts";

const [directory, updateChannel] = process.argv.slice(2);
if (!directory || !["latest", "beta", "preview", "nightly"].includes(updateChannel ?? "")) {
  throw new Error(
    "Usage: node scripts/verify-desktop-release-assets.ts <directory> <latest|beta|preview|nightly>",
  );
}

verifyAssembledDesktopReleaseAssets(directory, updateChannel as ReleaseMetadata["updateChannel"]);
console.log(`Verified assembled ${updateChannel} desktop release assets.`);
