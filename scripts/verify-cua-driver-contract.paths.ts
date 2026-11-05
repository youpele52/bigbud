import * as Path from "node:path";

/** Fixture folder for the pinned Driver: `scripts/fixtures/cua-driver/<version>`. */
export function cuaDriverContractFixtureDir(root: string, version: string): string {
  return Path.join(root, "scripts", "fixtures", "cua-driver", version);
}

/**
 * Where the harness may write its README: `null` when the fixture folder already
 * has one (for example the hand-written provenance record for 0.38.0's
 * `live-schema.darwin.json`), which must never be overwritten.
 */
export function cuaDriverContractReadmeTarget(
  fixtureDir: string,
  exists: (path: string) => boolean,
): string | null {
  const target = Path.join(fixtureDir, "README.md");
  return exists(target) ? null : target;
}

export function cuaDriverContractReadme(version: string, platform: string, arch: string): string {
  return `# cua-driver ${version} contract\n\nCaptured by \`bun run scripts/verify-cua-driver-contract.ts\` on ${platform}/${arch}. The harness uses production release metadata, child environment, invocation arguments, and policy bytes.\n`;
}
