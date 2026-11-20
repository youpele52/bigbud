import { execFileSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/** Architecture audit for packaged macOS apps (`bun run verify:desktop:mac-architecture`). */
export type MacAppArch = "arm64" | "x64";

/** The `lipo -archs` name of each desktop build architecture. */
export const LIPO_ARCH: Record<MacAppArch, string> = { arm64: "arm64", x64: "x86_64" };

const THIN_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe]);
const FAT_MAGICS = new Set([0xcafebabe, 0xcafebabf]);
// Java class files share 0xcafebabe; their next word holds the class version (>= 45), while a
// fat Mach-O stores a small slice count there.
const MAX_FAT_SLICES = 30;

export interface MachOAuditEntry {
  readonly path: string;
  readonly archs: readonly string[];
}

export interface MacAppAuditResult {
  readonly app: string;
  readonly audited: readonly MachOAuditEntry[];
  readonly offenders: readonly MachOAuditEntry[];
}

/** Classifies a file header (at least 8 bytes) as a thin or fat Mach-O, or neither. */
export function machOKind(header: Uint8Array): "thin" | "fat" | undefined {
  if (header.length < 8) return undefined;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const magic = view.getUint32(0, false);
  if (THIN_MAGICS.has(magic)) return "thin";
  if (!FAT_MAGICS.has(magic)) return undefined;
  const slices = view.getUint32(4, false);
  return slices > 0 && slices <= MAX_FAT_SLICES ? "fat" : undefined;
}

/** Splits `lipo -archs` output ("x86_64 arm64\n") into architecture names. */
export function parseLipoArchs(output: string): string[] {
  return output.trim().split(/\s+/).filter(Boolean);
}

/** Files that do not contain the expected slice; universal files that include it pass. */
export function findArchitectureOffenders(
  entries: readonly MachOAuditEntry[],
  expected: MacAppArch,
): MachOAuditEntry[] {
  return entries.filter((entry) => !entry.archs.includes(LIPO_ARCH[expected]));
}

export function parseAuditArgs(argv: readonly string[]): {
  readonly releaseRoot: string;
  readonly arch: MacAppArch;
} {
  const [releaseRoot, arch, ...rest] = argv.filter((argument) => argument !== "--");
  if (!releaseRoot || (arch !== "arm64" && arch !== "x64") || rest.length > 0) {
    throw new Error(
      "Usage: node scripts/verify-macos-app-architecture.ts <release-root> <arm64|x64>",
    );
  }
  return { releaseRoot, arch };
}

/** Top-level `.app` bundles under the electron-builder output (`mac/`, `mac-arm64/`, ...). */
export function findMacAppBundles(root: string, depth = 3): string[] {
  const bundles: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if (entry.name.endsWith(".app")) bundles.push(path);
    else if (depth > 1) bundles.push(...findMacAppBundles(path, depth - 1));
  }
  return bundles.toSorted();
}

function readHeader(path: string): Uint8Array {
  const header = new Uint8Array(8);
  const descriptor = openSync(path, "r");
  try {
    return header.subarray(0, readSync(descriptor, header, 0, 8, 0));
  } finally {
    closeSync(descriptor);
  }
}

/** Every regular Mach-O file in the bundle. Symlinks are skipped; their targets are visited. */
export function listMachOFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listMachOFiles(path));
    else if (entry.isFile() && lstatSync(path).size >= 8 && machOKind(readHeader(path)))
      files.push(path);
  }
  return files;
}

export function lipoArchs(path: string): string[] {
  return parseLipoArchs(execFileSync("lipo", ["-archs", path], { encoding: "utf8" }));
}

/** Audits one app; a file `lipo` cannot read is reported as an offender with no slices. */
export function auditMacApp(
  app: string,
  expected: MacAppArch,
  readArchs: (path: string) => readonly string[] = lipoArchs,
): MacAppAuditResult {
  const audited = listMachOFiles(app).map((path) => {
    let archs: readonly string[] = [];
    try {
      archs = readArchs(path);
    } catch {
      archs = [];
    }
    return { path, archs };
  });
  if (audited.length === 0) throw new Error(`No Mach-O files found in ${app}`);
  const macOS = join(app, "Contents", "MacOS");
  if (!audited.some((entry) => !relative(macOS, entry.path).startsWith(".."))) {
    throw new Error(`No Mach-O main executable found under ${macOS}`);
  }
  return { app, audited, offenders: findArchitectureOffenders(audited, expected) };
}

export function formatAuditReport(result: MacAppAuditResult, expected: MacAppArch): string {
  const name = LIPO_ARCH[expected];
  if (result.offenders.length === 0) {
    return `Audited ${result.audited.length} Mach-O files in ${result.app}: all contain ${name}.`;
  }
  return [
    `${result.offenders.length} of ${result.audited.length} Mach-O files in ${result.app} lack ${name}:`,
    ...result.offenders.map(
      (entry) =>
        `  ${relative(result.app, entry.path)} (${entry.archs.join(", ") || "unreadable by lipo"})`,
    ),
  ].join("\n");
}
