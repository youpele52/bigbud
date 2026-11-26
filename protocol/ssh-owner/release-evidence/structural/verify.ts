import { readFile, lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseAllowlist } from "./allowlist.ts";
import { checkStructural } from "./check.ts";
import type { SourceFile } from "./rules.ts";

const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  "coverage",
  ".turbo",
]);

function usage(): never {
  throw new Error("Usage: bun run verify.ts <path> [<path> ...] [--allowlist <allowlist.json>]");
}

function normalize(root: string, absolute: string) {
  const relative = path.relative(root, absolute);
  return (relative.startsWith("..") ? absolute : relative).replaceAll("\\", "/");
}

async function collect(
  root: string,
  target: string,
  files: SourceFile[],
  budget: { count: number },
) {
  const absolute = path.resolve(root, target);
  const info = await lstat(absolute).catch((cause: unknown) => {
    throw new Error(`Input path is missing or unreadable: ${target}`, { cause });
  });
  if (info.isSymbolicLink())
    throw new Error(`Input path is a symlink; pass its real target: ${target}`);
  if (info.isDirectory()) {
    for (const entry of (await readdir(absolute)).toSorted()) {
      if (SKIP_DIRS.has(entry)) continue;
      await collect(root, path.join(absolute, entry), files, budget);
    }
    return;
  }
  if (!info.isFile()) throw new Error(`Input path is not a file or directory: ${target}`);
  budget.count += 1;
  if (budget.count > MAX_FILES) throw new Error(`Input exceeds the ${MAX_FILES}-file limit`);
  if (info.size > MAX_FILE_BYTES) throw new Error(`Input file exceeds the 2 MiB limit: ${target}`);
  files.push({ path: normalize(root, absolute), content: await readFile(absolute, "utf8") });
}

async function main(args: string[]) {
  const root = process.cwd();
  const allowlistPath = (() => {
    const index = args.indexOf("--allowlist");
    if (index < 0) return path.join(path.dirname(fileURLToPath(import.meta.url)), "allowlist.json");
    const value = args[index + 1];
    if (!value) usage();
    args.splice(index, 2);
    return value;
  })();
  if (args.length === 0) usage();
  const files: SourceFile[] = [];
  const budget = { count: 0 };
  for (const target of args) await collect(root, target, files, budget);
  const allowlist = parseAllowlist(JSON.parse(await readFile(allowlistPath, "utf8")) as unknown);
  const report = checkStructural(files, allowlist);
  console.log(JSON.stringify(report, null, 2));
  if (report.summary.violations > 0) process.exitCode = 1;
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid structural input");
  process.exitCode = 1;
}
