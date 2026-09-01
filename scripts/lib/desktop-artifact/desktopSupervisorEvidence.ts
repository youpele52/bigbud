import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

interface CargoMetadata {
  readonly packages: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly license: string | null;
  }>;
  readonly resolve: {
    readonly nodes: ReadonlyArray<{
      readonly id: string;
      readonly dependencies: ReadonlyArray<string>;
    }>;
  } | null;
}

function resolveSupervisorPackages(metadata: CargoMetadata) {
  const root = metadata.packages.find((entry) => entry.name === "bigbud-desktop-supervisor");
  if (!root || !metadata.resolve) throw new Error("Cargo metadata omitted the supervisor graph");
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const pending = [root.id];
  const included = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (included.has(id)) continue;
    included.add(id);
    pending.push(...(nodes.get(id)?.dependencies ?? []));
  }
  return metadata.packages
    .filter((entry) => included.has(entry.id))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export function writeDesktopSupervisorArtifactEvidence(input: {
  readonly repoRoot: string;
  readonly binaryPath: string;
  readonly targetTriple: string;
}): void {
  const bytes = readFileSync(input.binaryPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const metadataResult = spawnSync("cargo", ["metadata", "--locked", "--format-version", "1"], {
    cwd: input.repoRoot,
    encoding: "utf8",
  });
  if (metadataResult.status !== 0) {
    throw new Error(`cargo metadata failed: ${metadataResult.stderr.trim()}`);
  }
  const metadata = JSON.parse(metadataResult.stdout) as CargoMetadata;
  const packages = resolveSupervisorPackages(metadata);
  const evidenceDir = dirname(input.binaryPath);
  writeFileSync(
    join(evidenceDir, "artifact-manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        binary: input.binaryPath.split(/[\\/]/).at(-1),
        targetTriple: input.targetTriple,
        protocol: { major: 1, minor: 3 },
        sizeBytes: bytes.length,
        sha256,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(evidenceDir, "sbom.cdx.json"),
    `${JSON.stringify(
      {
        bomFormat: "CycloneDX",
        specVersion: "1.5",
        version: 1,
        metadata: { component: { type: "application", name: "bigbud-desktop-supervisor" } },
        components: packages.map((entry) => ({
          type: "library",
          name: entry.name,
          version: entry.version,
          licenses: entry.license ? [{ expression: entry.license }] : [],
        })),
        licenseReview: {
          status: "requires-release-review",
          missingLicensePackages: packages
            .filter((entry) => !entry.license)
            .map((entry) => entry.name),
        },
      },
      null,
      2,
    )}\n`,
  );
}

export function verifyDesktopSupervisorArtifactEvidence(binaryPath: string): void {
  const evidenceDir = dirname(binaryPath);
  const manifest = JSON.parse(
    readFileSync(join(evidenceDir, "artifact-manifest.json"), "utf8"),
  ) as {
    readonly sha256?: unknown;
    readonly protocol?: { readonly major?: unknown; readonly minor?: unknown };
  };
  const expected = createHash("sha256").update(readFileSync(binaryPath)).digest("hex");
  if (
    manifest.sha256 !== expected ||
    manifest.protocol?.major !== 1 ||
    manifest.protocol.minor !== 3
  ) {
    throw new Error("desktop supervisor artifact manifest does not match the packaged binary");
  }
  const sbom = JSON.parse(readFileSync(join(evidenceDir, "sbom.cdx.json"), "utf8")) as {
    readonly bomFormat?: unknown;
  };
  if (sbom.bomFormat !== "CycloneDX") {
    throw new Error("desktop supervisor SBOM is missing or incompatible");
  }
}
