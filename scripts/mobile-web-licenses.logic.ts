import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { noticeFiles, type GraphNoticeEntry } from "./build-remote-backend-graph.notices.ts";

/** One npm package in the production dependency closure of a workspace app. */
export interface NpmPackageLicense {
  readonly name: string;
  readonly version: string;
  readonly license: string | null;
  readonly repository: string | null;
  readonly evidence: "file" | "declared" | "missing";
  readonly files: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
}

interface Manifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly license?: unknown;
  readonly repository?: unknown;
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

const text = (value: unknown) => (typeof value === "string" ? value : null);
const field = (value: unknown, key: string) =>
  text(value) ?? text((value as Record<string, unknown> | null)?.[key] ?? null);
const exists = (path: string) =>
  stat(path).then(
    (info) => info.isFile(),
    () => false,
  );

/** Node-style lookup: the nearest `node_modules/<name>` above the dependent's real directory. */
async function resolvePackage(from: string, name: string) {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name);
    if (await exists(join(candidate, "package.json"))) return realpath(candidate);
    if (dirname(directory) === directory) return null;
  }
}

/** Walk `dependencies` and installed `peerDependencies` from the app. `devDependencies` and
 * `optionalDependencies` are never followed: optional packages are platform-specific native
 * builds that a browser bundle cannot contain, and following them would make the output depend
 * on the build host. Workspace packages are bigbud's own code: they are traversed for their
 * dependencies but recorded once, as the project, with the root licence. */
export async function npmProductionClosure(workspaceRoot: string, app: string) {
  const root = await realpath(workspaceRoot);
  const isWorkspace = (directory: string) => {
    const path = relative(root, directory);
    return !path.startsWith("..") && !path.split(sep).includes("node_modules");
  };
  const seen = new Set<string>();
  const packages = new Map<string, NpmPackageLicense>();
  const sources = new Map<string, string>();
  const queue = [await realpath(join(root, app))];
  for (let directory = queue.shift(); directory !== undefined; directory = queue.shift()) {
    if (seen.has(directory)) continue;
    seen.add(directory);
    const manifest = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    ) as Manifest;
    const name = text(manifest.name);
    const version = text(manifest.version);
    if (!isWorkspace(directory)) {
      if (!name || !version) throw new Error(`Package at ${directory} has no name or version.`);
      const key = `${name}@${version}`;
      if (!packages.has(key)) {
        const files = await noticeFiles(directory, key);
        for (const file of files)
          sources.set(file.path, join(directory, file.path.slice(key.length + 1)));
        const license = field(manifest.license, "type");
        packages.set(key, {
          name,
          version,
          license,
          repository: field(manifest.repository, "url"),
          evidence: files.length ? "file" : license ? "declared" : "missing",
          files,
        });
      }
    }
    const required = Object.keys(manifest.dependencies ?? {});
    const optional = Object.keys(manifest.peerDependencies ?? {});
    for (const dependency of [...required, ...optional].toSorted()) {
      const resolved = await resolvePackage(directory, dependency);
      if (resolved) queue.push(resolved);
      else if (required.includes(dependency) && !optional.includes(dependency))
        throw new Error(`Production dependency ${dependency} of ${name} is not installed.`);
    }
  }
  const projectFiles = await noticeFiles(root, "workspace");
  for (const file of projectFiles) sources.set(file.path, join(root, file.path.slice(10)));
  const sorted = [...packages.values()].toSorted((a, b) =>
    a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1,
  );
  return { packages: sorted, projectFiles, sources };
}

export function npmLicenseInventory(input: {
  readonly root: string;
  readonly lockfileSha256: string;
  readonly packages: ReadonlyArray<NpmPackageLicense>;
}) {
  const byLicense = new Map<string, number>();
  for (const pkg of input.packages)
    byLicense.set(pkg.license ?? "UNKNOWN", (byLicense.get(pkg.license ?? "UNKNOWN") ?? 0) + 1);
  return {
    schemaVersion: 1,
    purpose: "npm-production-dependency-license-inventory",
    note:
      "Production dependency closure from package.json files of the installed workspace, a " +
      "superset of what the bundler emits; this is an inventory, not a legal review.",
    root: input.root,
    lockfileSha256: input.lockfileSha256,
    summary: {
      packages: input.packages.length,
      byLicense: Object.fromEntries([...byLicense].toSorted((a, b) => (a[0] < b[0] ? -1 : 1))),
      withoutLicenseFiles: input.packages
        .filter((pkg) => pkg.evidence !== "file")
        .map((pkg) => `${pkg.name}@${pkg.version}`),
    },
    packages: input.packages,
  };
}

/** The project entry first, then every package, in the shared notice-entry shape. */
export function npmNoticeEntries(
  closure: Awaited<ReturnType<typeof npmProductionClosure>>,
): GraphNoticeEntry[] {
  return [
    {
      kind: "project",
      name: "bigbud",
      version: "",
      license: "MIT",
      directory: "workspace",
      files: closure.projectFiles,
    },
    ...closure.packages.map(
      (pkg): GraphNoticeEntry => ({
        kind: "package",
        name: pkg.name,
        version: pkg.version,
        license: pkg.license,
        directory: "npm",
        files: pkg.files,
      }),
    ),
  ];
}
