import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { noticeFiles, type GraphNoticeEntry } from "./build-remote-backend-graph.notices.ts";

/** The subset of `cargo metadata --format-version 1` this inventory reads. */
export interface CargoMetadata {
  readonly workspace_root: string;
  readonly workspace_members: ReadonlyArray<string>;
  readonly packages: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly license: string | null;
    readonly license_file: string | null;
    readonly source: string | null;
    readonly repository: string | null;
    readonly manifest_path: string;
    readonly targets: ReadonlyArray<{ readonly kind: ReadonlyArray<string> }>;
  }>;
  readonly resolve: {
    readonly nodes: ReadonlyArray<{
      readonly id: string;
      readonly deps: ReadonlyArray<{
        readonly pkg: string;
        readonly dep_kinds: ReadonlyArray<{ readonly kind: string | null }>;
      }>;
    }>;
  } | null;
}

/** `linked`: compiled into the shipped binary. `build-time`: build scripts, proc macros and
 * their dependencies, which run on the build host and are not linked into the binary. */
export type CrateUse = "linked" | "build-time";
export type LicenseEvidence = "file" | "declared" | "missing";

export interface RustCrateLicense {
  readonly name: string;
  readonly version: string;
  /** `workspace`, `crates.io`, or the raw Cargo source for anything else (git, other registry). */
  readonly source: string;
  readonly repository: string | null;
  readonly license: string | null;
  readonly licenseFile: string | null;
  readonly use: CrateUse;
  readonly evidence: LicenseEvidence;
  readonly files: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
}

const CRATES_IO = "registry+https://github.com/rust-lang/crates.io-index";
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const byName = (a: RustCrateLicense, b: RustCrateLicense) =>
  a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1;

/** Crates reachable from `root` through normal and build edges; dev-only edges are ignored.
 * Platform filtering is cargo's (`--filter-platform`), so the resolve already matches a target. */
export function crateClosure(metadata: CargoMetadata, root: string) {
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const rootId = metadata.workspace_members.find((id) => packages.get(id)?.name === root);
  if (!rootId || !metadata.resolve) throw new Error(`Workspace package ${root} is not resolved.`);
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const isProcMacro = (id: string) =>
    packages.get(id)?.targets.some((target) => target.kind.includes("proc-macro")) ?? false;
  const walk = (follow: (kind: string | null) => boolean, enter: (id: string) => boolean) => {
    const seen = new Set<string>([rootId]);
    const queue = [rootId];
    for (let id = queue.shift(); id !== undefined; id = queue.shift())
      for (const dep of nodes.get(id)?.deps ?? [])
        if (!seen.has(dep.pkg) && dep.dep_kinds.some((k) => follow(k.kind)) && enter(dep.pkg)) {
          seen.add(dep.pkg);
          queue.push(dep.pkg);
        }
    return seen;
  };
  const linked = walk(
    (kind) => kind === null,
    (id) => !isProcMacro(id),
  );
  const all = walk(
    (kind) => kind === null || kind === "build",
    () => true,
  );
  return [...all].map((id) => {
    const pkg = packages.get(id);
    if (!pkg) throw new Error(`Resolved crate ${id} has no package metadata.`);
    return { pkg, use: (linked.has(id) ? "linked" : "build-time") as CrateUse };
  });
}

/** One record per crate with its declared license and the license files it ships. Workspace
 * crates inherit the workspace license, so the repository's root license files are attached. */
export async function rustCrateLicenses(metadata: CargoMetadata, root: string) {
  const crates: RustCrateLicense[] = [];
  const sources = new Map<string, string>();
  const rootFiles = await noticeFiles(metadata.workspace_root, "workspace");
  for (const { pkg, use } of crateClosure(metadata, root)) {
    const directory = dirname(pkg.manifest_path);
    const prefix = `${pkg.name}@${pkg.version}`;
    const files = [...(await noticeFiles(directory, prefix))];
    if (pkg.license_file && !files.some((f) => f.path === posix.join(prefix, pkg.license_file!))) {
      const path = posix.join(prefix, pkg.license_file);
      const bytes = await readFile(join(directory, pkg.license_file)).catch(() => null);
      if (bytes) files.push({ path, sha256: sha256(bytes) });
    }
    if (pkg.source === null && !files.length) files.push(...rootFiles);
    for (const file of files)
      sources.set(
        file.path,
        file.path.startsWith("workspace/")
          ? join(metadata.workspace_root, file.path.slice("workspace/".length))
          : join(directory, file.path.slice(prefix.length + 1)),
      );
    crates.push({
      name: pkg.name,
      version: pkg.version,
      source:
        pkg.source === null ? "workspace" : pkg.source === CRATES_IO ? "crates.io" : pkg.source,
      repository: pkg.repository,
      license: pkg.license,
      licenseFile: pkg.license_file,
      use,
      evidence: files.length ? "file" : pkg.license ? "declared" : "missing",
      files: files.toSorted((a, b) => (a.path < b.path ? -1 : 1)),
    });
  }
  return { crates: crates.toSorted(byName), sources };
}

/** Facts about code the toolchain links in, which cargo metadata does not list. */
export function linkedRuntimeNotes(target: string) {
  const notes = ["Rust standard library from the pinned toolchain (rust-toolchain.toml)."];
  if (target.endsWith("-musl"))
    notes.push("musl libc is linked statically from Rust's self-contained musl target.");
  else if (target.includes("-linux-gnu"))
    notes.push("glibc is linked dynamically from the host and is not shipped.");
  return notes;
}

export function rustLicenseInventory(input: {
  readonly root: string;
  readonly target: string;
  readonly cargoLockSha256: string;
  readonly crates: ReadonlyArray<RustCrateLicense>;
}) {
  const count = (pick: (c: RustCrateLicense) => string) => {
    const counts = new Map<string, number>();
    for (const crate of input.crates) counts.set(pick(crate), (counts.get(pick(crate)) ?? 0) + 1);
    return Object.fromEntries([...counts].toSorted((a, b) => (a[0] < b[0] ? -1 : 1)));
  };
  return {
    schemaVersion: 1,
    purpose: "rust-dependency-license-inventory",
    note: "Generated from cargo metadata; this is an inventory, not a legal review.",
    root: input.root,
    target: input.target,
    cargoLockSha256: input.cargoLockSha256,
    linkedRuntime: linkedRuntimeNotes(input.target),
    summary: {
      crates: input.crates.length,
      byUse: count((c) => c.use),
      byEvidence: count((c) => c.evidence),
      byLicense: count((c) => c.license ?? "UNKNOWN"),
      withoutLicenseFiles: input.crates
        .filter((c) => c.evidence !== "file")
        .map((c) => `${c.name}@${c.version}`),
    },
    crates: input.crates,
  };
}

/** Linked crates in the shared notice-entry shape, for `renderThirdPartyNotices`. */
export function linkedCrateNoticeEntries(crates: ReadonlyArray<RustCrateLicense>) {
  return crates
    .filter((crate) => crate.use === "linked")
    .map(
      (crate): GraphNoticeEntry => ({
        kind: crate.source === "workspace" ? "project" : "package",
        name: crate.name,
        version: crate.version,
        license: crate.license,
        directory: crate.source,
        files: crate.files,
      }),
    );
}
