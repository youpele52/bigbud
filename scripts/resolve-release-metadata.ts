#!/usr/bin/env node

import { appendFileSync } from "node:fs";

import { resolveReleaseMetadata } from "./lib/release-metadata.ts";

const [rawVersion, outputFlag, outputPath] = process.argv.slice(2);
if (!rawVersion) {
  throw new Error(
    "Usage: bun scripts/resolve-release-metadata.ts <version> [--github-output <path>]",
  );
}
if ((outputFlag || outputPath) && (outputFlag !== "--github-output" || !outputPath)) {
  throw new Error("Expected --github-output followed by a path.");
}

const metadata = resolveReleaseMetadata(rawVersion);
const outputs = {
  channel: metadata.channel,
  is_prerelease: String(metadata.isPrerelease),
  make_latest: String(metadata.makeLatest),
  tag: metadata.tag,
  update_channel: metadata.updateChannel,
  version: metadata.version,
};

if (outputPath) {
  appendFileSync(
    outputPath,
    `${Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
  );
} else {
  process.stdout.write(`${JSON.stringify(outputs)}\n`);
}
