import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";

/** Notice inventory for the staged graph. It records what the graph carries; it is not a legal
 * review, and packages without a license file are listed with empty `files` for follow-up. */
export interface GraphNoticeEntry {
  readonly kind: "package" | "bundled" | "runtime" | "project";
  readonly name: string;
  readonly version: string;
  readonly license: string | null;
  /** Graph-relative directory for installed packages; empty for bundled code. */
  readonly directory: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
}
const noticeName =
  /^(?:licen[cs]e|notice|copying|copyright|authors|third[-_]party[-_]notices?|patents)(?:[-_.][A-Za-z0-9.-]*)?$/i;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const byPath = <T extends { path: string }>(a: T, b: T) => (a.path < b.path ? -1 : 1);

function licenseOf(manifest: Record<string, unknown>): string | null {
  const value = manifest.license;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string")
    return (value as { type: string }).type;
  return null;
}

/** Top-level notice files plus a `LICENSES/` directory, as package authors ship them. */
export async function noticeFiles(directory: string, graphPrefix: string) {
  const files: { path: string; sha256: string }[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && noticeName.test(entry.name))
      files.push({
        path: posix.join(graphPrefix, entry.name),
        sha256: sha256(await readFile(join(directory, entry.name))),
      });
    if (entry.isDirectory() && /^licen[cs]es$/i.test(entry.name))
      for (const child of await readdir(join(directory, entry.name), { withFileTypes: true }))
        if (child.isFile())
          files.push({
            path: posix.join(graphPrefix, entry.name, child.name),
            sha256: sha256(await readFile(join(directory, entry.name, child.name))),
          });
  }
  return files.toSorted(byPath);
}

/** Every directory with a named, versioned package.json under node_modules is a package. */
export async function collectPackageNotices(graphRoot: string): Promise<GraphNoticeEntry[]> {
  const entries: GraphNoticeEntry[] = [];
  async function visit(relative: string): Promise<void> {
    const absolute = join(graphRoot, relative);
    const children = await readdir(absolute, { withFileTypes: true });
    if (children.some((child) => child.isFile() && child.name === "package.json")) {
      const manifest = JSON.parse(await readFile(join(absolute, "package.json"), "utf8")) as Record<
        string,
        unknown
      >;
      if (
        typeof manifest.name === "string" &&
        typeof manifest.version === "string" &&
        posix.basename(posix.dirname(relative)).match(/^(?:node_modules|@[^/]+)$/)
      )
        entries.push({
          kind: "package",
          name: manifest.name,
          version: manifest.version,
          license: licenseOf(manifest),
          directory: relative,
          files: await noticeFiles(absolute, relative),
        });
    }
    for (const child of children)
      if (child.isDirectory()) await visit(posix.join(relative, child.name));
  }
  await visit("node_modules");
  return entries.toSorted((a, b) => (a.directory < b.directory ? -1 : 1));
}

/** Packages inlined into the server bundle, read from rolldown `//#region` markers such as
 * `../../node_modules/.bun/<store>/node_modules/<name>/file.js`. */
export function bundledPackagesFromRegions(texts: Iterable<string>) {
  const found = new Map<string, { name: string; storePath: string }>();
  for (const text of texts)
    for (const match of text.matchAll(
      /^\/\/#region (?:\.\.\/)*node_modules\/\.bun\/([^/\n]+)\/node_modules\/((?:@[^/\n]+\/)?[^/\n]+)\//gm,
    )) {
      const storePath = `node_modules/.bun/${match[1]}/node_modules/${match[2]}`;
      found.set(storePath, { name: match[2]!, storePath });
    }
  return [...found.values()].toSorted((a, b) => (a.storePath < b.storePath ? -1 : 1));
}

/** Notices for inlined packages are read from the workspace install that produced the bundle
 * and copied under `notices/bundled/<name>@<version>/`. */
export async function collectBundledNotices(input: {
  workspaceRoot: string;
  bundleTexts: Iterable<string>;
}) {
  const entries: GraphNoticeEntry[] = [];
  const copies: { from: string; to: string }[] = [];
  for (const pkg of bundledPackagesFromRegions(input.bundleTexts)) {
    const directory = join(input.workspaceRoot, pkg.storePath);
    let manifest: Record<string, unknown> = {};
    try {
      manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    } catch {
      /* Recorded below with an unknown version and no files. */
    }
    const version = typeof manifest.version === "string" ? manifest.version : "unknown";
    const prefix = `notices/bundled/${pkg.name.replace("/", "+")}@${version}`;
    const files = await noticeFiles(directory, prefix).catch(() => []);
    for (const file of files)
      copies.push({ from: join(directory, file.path.slice(prefix.length + 1)), to: file.path });
    entries.push({
      kind: "bundled",
      name: pkg.name,
      version,
      license: licenseOf(manifest),
      directory: "",
      files,
    });
  }
  const unique = new Map(entries.map((entry) => [`${entry.name}@${entry.version}`, entry]));
  return { entries: [...unique.values()], copies };
}

export function noticeSummary(entries: ReadonlyArray<GraphNoticeEntry>) {
  const withoutFiles = entries.filter((entry) => !entry.files.length);
  const licenses = new Map<string, number>();
  for (const entry of entries)
    licenses.set(entry.license ?? "UNKNOWN", (licenses.get(entry.license ?? "UNKNOWN") ?? 0) + 1);
  return {
    packages: entries.length,
    withoutNoticeFiles: withoutFiles.map((entry) => `${entry.name}@${entry.version}`).toSorted(),
    licenses: Object.fromEntries([...licenses].toSorted((a, b) => (a[0] < b[0] ? -1 : 1))),
  };
}

/** Plain-text aggregate of every notice file the entries reference, in entry order. It is derived
 * from the same entries as `NOTICES.json` and states declared-only or missing evidence as such;
 * it does not interpret any license. `read` returns a referenced file's bytes, which must still
 * match the recorded hash. */
export async function renderThirdPartyNotices(
  title: string,
  entries: ReadonlyArray<GraphNoticeEntry>,
  read: (path: string) => Promise<Buffer>,
) {
  const rule = "=".repeat(78);
  const parts = [
    `${title}\n\nThis file collects the license and notice files shipped with each component, ` +
      `as listed in the\naccompanying inventory. It is generated, not a legal review.\n`,
  ];
  for (const entry of entries) {
    const label = entry.version ? `${entry.name}@${entry.version}` : entry.name;
    parts.push(
      `\n${rule}\n${label} (${entry.kind})\nDeclared license: ${entry.license ?? "none declared"}\n` +
        `Location: ${entry.directory || (entry.kind === "bundled" ? "inlined into the server bundle" : "archive root")}\n`,
    );
    if (!entry.files.length)
      parts.push("\nNo license or notice file is shipped for this component.\n");
    for (const file of entry.files) {
      const bytes = await read(file.path);
      if (sha256(bytes) !== file.sha256)
        throw new Error(`Notice file ${file.path} changed after it was inventoried.`);
      const text = bytes.includes(0)
        ? `[binary file, ${bytes.length} bytes]`
        : bytes.toString("utf8").replace(/\r\n?/g, "\n").trimEnd();
      parts.push(`\n--- ${file.path} (sha256 ${file.sha256}) ---\n\n${text}\n`);
    }
  }
  return parts.join("");
}
