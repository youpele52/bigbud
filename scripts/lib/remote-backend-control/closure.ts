import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const pinnedInputs = {
  server: "package/dist/bin.mjs",
  worker: "package/dist/NodeSqliteWorker.mjs",
  runtime: "package/runtime/node",
  lock: "package/package-lock.json",
  addon: "bullseye-addon/node-pty/build/Release/pty.node",
} as const;
export type ControlPins = Record<keyof typeof pinnedInputs, string>;
export const addonDestination = "node_modules/node-pty/build/Release/pty.node";
export const maximumEntries = 100_000;
export const maximumBytes = 4 * 1024 ** 3;

function unsafeCharacters(value: string): boolean {
  return [...value].some(
    (character) =>
      character === "\\" ||
      character === ":" ||
      character.charCodeAt(0) < 32 ||
      character.charCodeAt(0) === 127,
  );
}

export type ClosureEntry = {
  path: string;
  mode: number;
} & (
  | { kind: "directory" }
  | { kind: "symlink"; target: string }
  | { kind: "file"; size: number; sha256: string; source: string }
);

export function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !child.startsWith(sep))
  );
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

export function parsePins(value: unknown): ControlPins {
  if (typeof value !== "object" || value === null) throw new Error("Expected input SHA-256 pins.");
  const pins = value as Record<string, unknown>;
  for (const key of Object.keys(pinnedInputs)) {
    if (typeof pins[key] !== "string" || !/^[a-f0-9]{64}$/.test(pins[key])) {
      throw new Error(`Missing or invalid input pin: ${key}`);
    }
  }
  if (Object.keys(pins).length !== Object.keys(pinnedInputs).length) {
    throw new Error("Unexpected input pin.");
  }
  return Object.fromEntries(
    Object.keys(pinnedInputs).map((key) => [key, pins[key]]),
  ) as ControlPins;
}

export function portableEntries(entries: readonly ClosureEntry[]) {
  return entries.map((entry) => {
    if (entry.kind !== "file") return entry;
    const { source: _source, ...portable } = entry;
    return portable;
  });
}

export async function collectClosure(baselineRoot: string, pins: ControlPins) {
  parsePins(pins);
  const baseline = await realpath(baselineRoot);
  const packageRoot = join(baseline, "package");
  if ((await realpath(packageRoot)) !== packageRoot)
    throw new Error("Package root must not be a link.");
  for (const [key, path] of Object.entries(pinnedInputs)) {
    const source = join(baseline, path);
    if ((await realpath(source)) !== source || !(await lstat(source)).isFile()) {
      throw new Error(`Pinned input must be a regular unlinked file: ${path}`);
    }
    if ((await hashFile(source)) !== pins[key as keyof ControlPins]) {
      throw new Error(`Input pin mismatch: ${key}`);
    }
  }
  const entries: ClosureEntry[] = [];
  let installedBytes = 0;
  async function visit(path: string): Promise<void> {
    if (entries.length >= maximumEntries) throw new Error("Closure entry budget exceeded.");
    if (unsafeCharacters(path)) throw new Error("Unsafe closure path.");
    const original = join(packageRoot, path);
    const info = await lstat(original);
    if (info.isSymbolicLink()) {
      const target = await readlink(original);
      if (target.startsWith("/") || unsafeCharacters(target)) {
        throw new Error(`Unsafe closure link: ${path}`);
      }
      const destination = await realpath(original);
      if (!isWithin(packageRoot, destination)) throw new Error(`Escaping closure link: ${path}`);
      entries.push({ path, kind: "symlink", mode: 0o777, target });
    } else if (info.isDirectory()) {
      entries.push({ path, kind: "directory", mode: 0o755 });
      for (const child of (await readdir(original)).toSorted()) await visit(`${path}/${child}`);
    } else if (info.isFile()) {
      const source = path === addonDestination ? join(baseline, pinnedInputs.addon) : original;
      const size = (await lstat(source)).size;
      installedBytes += size;
      if (installedBytes > maximumBytes) throw new Error("Closure byte budget exceeded.");
      entries.push({
        path,
        kind: "file",
        mode: info.mode & 0o111 ? 0o755 : 0o644,
        source,
        size,
        sha256: await hashFile(source),
      });
    } else {
      throw new Error(`Unsupported closure entry: ${path}`);
    }
  }
  for (const path of ["dist", "node_modules", "package-lock.json", "package.json", "runtime"]) {
    await visit(path);
  }
  const paths = new Set(entries.map((entry) => entry.path));
  for (const entry of entries) {
    if (entry.kind === "symlink") {
      const target = relative(packageRoot, await realpath(join(packageRoot, entry.path)))
        .split(sep)
        .join("/");
      if (!paths.has(target))
        throw new Error(`Closure link points outside selected entries: ${entry.path}`);
    }
  }
  const addon = entries.find((entry) => entry.path === addonDestination);
  if (addon?.kind !== "file" || addon.sha256 !== pins.addon)
    throw new Error("Floor addon overlay is missing.");
  for (const path of ["runtime/node", "dist/NodeSqliteWorker.mjs", "dist/bin.mjs"]) {
    if (!paths.has(path)) throw new Error(`Required runtime entry missing: ${path}`);
  }
  return { entries, installedBytes, baseline };
}
