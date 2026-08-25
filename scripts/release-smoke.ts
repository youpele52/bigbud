import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveReleaseMetadata } from "./lib/release-metadata.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const workspaceFiles = [
  "package.json",
  "bun.lock",
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "apps/marketing/package.json",
  "packages/contracts/package.json",
  "packages/effect-acp/package.json",
  "packages/shared/package.json",
  "scripts/package.json",
] as const;

function copyWorkspaceManifestFixture(targetRoot: string): void {
  for (const relativePath of workspaceFiles) {
    const sourcePath = resolve(repoRoot, relativePath);
    const destinationPath = resolve(targetRoot, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(sourcePath, destinationPath);
  }
}

function writeMacManifestFixtures(
  targetRoot: string,
  version: string,
): { arm64Path: string; x64Path: string } {
  const { updateChannel } = resolveReleaseMetadata(version);
  const assetDirectory = resolve(targetRoot, `release-assets-${updateChannel}`);
  mkdirSync(assetDirectory, { recursive: true });

  const arm64Path = resolve(assetDirectory, `${updateChannel}-mac.yml`);
  const x64Path = resolve(assetDirectory, `${updateChannel}-mac-x64.yml`);

  writeFileSync(
    arm64Path,
    `version: ${version}
files:
  - url: bigbud-${version}-arm64.zip
    sha512: arm64zip
    size: 125621344
  - url: bigbud-${version}-arm64.dmg
    sha512: arm64dmg
    size: 131754935
path: bigbud-${version}-arm64.zip
sha512: arm64zip
releaseDate: '2026-03-08T10:32:14.587Z'
`,
  );

  writeFileSync(
    x64Path,
    `version: ${version}
files:
  - url: bigbud-${version}-x64.zip
    sha512: x64zip
    size: 132000112
  - url: bigbud-${version}-x64.dmg
    sha512: x64dmg
    size: 138148807
path: bigbud-${version}-x64.zip
sha512: x64zip
releaseDate: '2026-03-08T10:36:07.540Z'
`,
  );

  return { arm64Path, x64Path };
}

function assertContains(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(message);
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), "bigbud-release-smoke-"));

try {
  const releaseWorkflow = readFileSync(resolve(repoRoot, ".github/workflows/release.yml"), "utf8");
  const ciWorkflow = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
  for (const credential of [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
  ]) {
    assertContains(
      releaseWorkflow,
      `secrets.${credential}`,
      `Release workflow is missing ${credential}.`,
    );
  }
  assertContains(
    releaseWorkflow,
    "--require-code-signature",
    "Release workflow must verify the macOS sidecar signature.",
  );
  for (const credential of ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]) {
    assertContains(
      releaseWorkflow,
      `${credential}: \${{ matrix.platform == 'mac' && secrets.${credential} || '' }}`,
      `Release matrix builds must scope ${credential} to macOS.`,
    );
  }
  if (releaseWorkflow.includes("AZURE_TRUSTED_SIGNING")) {
    throw new Error("Release workflow must keep Windows artifacts unsigned.");
  }
  if (ciWorkflow.includes("secrets.APPLE_") || ciWorkflow.includes("--signed")) {
    throw new Error("CI must remain unsigned and free of Apple signing credentials.");
  }

  copyWorkspaceManifestFixture(tempRoot);

  execFileSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/update-release-package-versions.ts"),
      "9.9.9-preview.0",
      "--root",
      tempRoot,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  execFileSync("bun", ["install", "--lockfile-only", "--ignore-scripts"], {
    cwd: tempRoot,
    stdio: "inherit",
  });

  const lockfile = readFileSync(resolve(tempRoot, "bun.lock"), "utf8");
  assertContains(
    lockfile,
    `"version": "9.9.9-preview.0"`,
    "Expected bun.lock to contain the smoke version.",
  );

  for (const version of ["9.9.9", "9.9.9-beta.1", "9.9.9-preview.1", "9.9.9-nightly.20260824"]) {
    const metadata = resolveReleaseMetadata(version);
    const { arm64Path, x64Path } = writeMacManifestFixtures(tempRoot, version);
    assertContains(
      arm64Path,
      `${metadata.updateChannel}-mac.yml`,
      `Wrong manifest name for ${metadata.channel}.`,
    );
    execFileSync(
      process.execPath,
      [resolve(repoRoot, "scripts/merge-mac-update-manifests.ts"), arm64Path, x64Path],
      { cwd: repoRoot, stdio: "inherit" },
    );

    const mergedManifest = readFileSync(arm64Path, "utf8");
    assertContains(
      mergedManifest,
      `bigbud-${version}-arm64.zip`,
      `Merged ${metadata.channel} manifest is missing the arm64 asset.`,
    );
    assertContains(
      mergedManifest,
      `bigbud-${version}-x64.zip`,
      `Merged ${metadata.channel} manifest is missing the x64 asset.`,
    );
  }

  console.log("Release smoke checks passed.");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
