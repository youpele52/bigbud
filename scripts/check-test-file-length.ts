import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

interface TestFileLengthBaseline {
  readonly maxLines: number;
  readonly warningLines: number;
  readonly files: Readonly<Record<string, number>>;
}

interface TestFileRecord {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly lines: number;
}

const TEST_FILE_SUFFIXES = [
  ".test.ts",
  ".test.tsx",
  ".spec.ts",
  ".spec.tsx",
  ".test.js",
  ".spec.js",
] as const;

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".turbo",
  "dist",
  "dist-electron",
  "node_modules",
  "coverage",
]);

function isTestFile(path: string): boolean {
  return TEST_FILE_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

function countLines(filePath: string): number {
  const content = readFileSync(filePath, "utf8");
  if (content.length === 0) {
    return 0;
  }

  return content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
}

function collectTestFiles(rootDir: string, currentDir = rootDir): Array<TestFileRecord> {
  const entries = readdirSync(currentDir, { withFileTypes: true }).toSorted((left, right) =>
    left.name.localeCompare(right.name),
  );
  const files: Array<TestFileRecord> = [];

  for (const entry of entries) {
    const absolutePath = join(currentDir, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      files.push(...collectTestFiles(rootDir, absolutePath));
      continue;
    }

    if (!entry.isFile() || !isTestFile(entry.name)) {
      continue;
    }

    files.push({
      absolutePath,
      relativePath: relative(rootDir, absolutePath),
      lines: countLines(absolutePath),
    });
  }

  return files;
}

function readBaseline(rootDir: string): TestFileLengthBaseline {
  const baselinePath = resolve(rootDir, ".config/test-file-length-baseline.json");
  return JSON.parse(readFileSync(baselinePath, "utf8")) as TestFileLengthBaseline;
}

function formatFileList(title: string, files: ReadonlyArray<TestFileRecord>): Array<string> {
  if (files.length === 0) {
    return [];
  }

  return [
    title,
    ...files.map((file) => `  ${String(file.lines).padStart(4, " ")}  ${file.relativePath}`),
    "",
  ];
}

function run() {
  const rootDir = resolve(import.meta.dirname, "..");
  const baseline = readBaseline(rootDir);
  const testFiles = collectTestFiles(rootDir);
  const warnings: Array<TestFileRecord> = [];
  const failingFiles: Array<TestFileRecord> = [];
  const missingBaselineEntries = new Set(Object.keys(baseline.files));

  for (const file of testFiles) {
    const baselineLines = baseline.files[file.relativePath];
    if (baselineLines !== undefined) {
      missingBaselineEntries.delete(file.relativePath);
    }

    if (file.lines > baseline.maxLines) {
      failingFiles.push(file);
      continue;
    }

    if (file.lines > baseline.warningLines) {
      warnings.push(file);
      continue;
    }
  }

  if (warnings.length > 0) {
    console.warn(
      [
        `Warning: ${warnings.length} test file(s) exceed ${baseline.warningLines} lines.`,
        "Keep test files at or below 400 lines where practical and never grow existing oversized files.",
        "",
        ...formatFileList("Warning files:", warnings),
      ].join("\n"),
    );
  }

  if (missingBaselineEntries.size > 0) {
    console.error(
      [
        "Error: baseline references missing test files.",
        "Remove deleted files from .config/test-file-length-baseline.json before merging.",
        "",
        ...Array.from(missingBaselineEntries)
          .toSorted((left, right) => left.localeCompare(right))
          .map((filePath) => `  ${filePath}`),
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  if (failingFiles.length > 0) {
    console.error(
      [
        `Error: ${failingFiles.length} test file(s) violate the test file length policy.`,
        `New or changed test files must stay at or below ${baseline.warningLines} lines unless explicitly baselined.`,
        `No test file may exceed its baseline, and ${baseline.maxLines} lines is the hard cap for non-baselined files.`,
        "",
        ...formatFileList("Failing files:", failingFiles),
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `Test file length check passed: ${String(testFiles.length)} file(s) scanned, ` +
      `${String(warnings.length)} warning file(s), no policy violations.`,
  );
}

run();
