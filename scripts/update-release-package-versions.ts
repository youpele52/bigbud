import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releasePackageFiles, stampReleasePackageJson } from "./lib/release-package-stamp.ts";
import { resolveReleaseMetadata } from "./lib/release-metadata.ts";

interface UpdateReleasePackageVersionsOptions {
  readonly rootDir?: string;
}

export function updateReleasePackageVersions(
  version: string,
  options: UpdateReleasePackageVersionsOptions = {},
): { changed: boolean } {
  const release = resolveReleaseMetadata(version);
  const rootDir = resolve(options.rootDir ?? process.cwd());
  let changed = false;

  for (const relativePath of releasePackageFiles) {
    const filePath = resolve(rootDir, relativePath);
    const stamped = stampReleasePackageJson(relativePath, readFileSync(filePath, "utf8"), release);
    if (stamped === null) continue;

    writeFileSync(filePath, stamped);
    changed = true;
  }

  return { changed };
}

function parseArgs(argv: ReadonlyArray<string>): {
  version: string;
  rootDir: string | undefined;
  writeGithubOutput: boolean;
} {
  let version: string | undefined;
  let rootDir: string | undefined;
  let writeGithubOutput = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }

    if (argument === "--github-output") {
      writeGithubOutput = true;
      continue;
    }

    if (argument === "--root") {
      rootDir = argv[index + 1];
      if (!rootDir) {
        throw new Error("Missing value for --root.");
      }
      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      throw new Error(`Unknown argument: ${argument}`);
    }

    if (version !== undefined) {
      throw new Error("Only one release version can be provided.");
    }
    version = argument;
  }

  if (!version) {
    throw new Error(
      "Usage: node scripts/update-release-package-versions.ts <version> [--root <path>] [--github-output]",
    );
  }

  return { version, rootDir, writeGithubOutput };
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const { version, rootDir, writeGithubOutput } = parseArgs(process.argv.slice(2));
  const { changed } = updateReleasePackageVersions(
    version,
    rootDir === undefined ? {} : { rootDir },
  );

  if (!changed) {
    console.log("All package.json versions already match release version.");
  }

  if (writeGithubOutput) {
    const githubOutputPath = process.env.GITHUB_OUTPUT;
    if (!githubOutputPath) {
      throw new Error("GITHUB_OUTPUT is required when --github-output is set.");
    }
    appendFileSync(githubOutputPath, `changed=${changed}\n`);
  }
}
