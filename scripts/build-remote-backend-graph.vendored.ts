import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { GraphNoticeEntry } from "./build-remote-backend-graph.notices.ts";

/** Upstream licence files kept in-repo for graph packages that publish none, with the exact
 * source of each file. They are verified by SHA-256 before they enter a graph. */
export const VENDORED_LICENSES_DIRECTORY = "scripts/remote-backend-graph/licenses";
export const VENDORED_GRAPH_PREFIX = "notices/vendored";

export interface VendoredLicenseFile {
  readonly file: string;
  readonly sha256: string;
  readonly sourceUrl: string;
  readonly repository: string | null;
  readonly ref: string;
  readonly commit: string | null;
  readonly path: string;
  readonly retrieved: string;
  readonly covers?: string;
  readonly note?: string;
}

export type VendoredLicensePackage =
  | {
      readonly name: string;
      readonly version: string;
      readonly declaredRepository: string | null;
      readonly status: "vendored";
      readonly files: ReadonlyArray<VendoredLicenseFile>;
      readonly note?: string;
    }
  | {
      readonly name: string;
      readonly version: string;
      readonly declaredRepository: string | null;
      readonly status: "no-license-file-upstream";
      readonly checked: {
        readonly repository: string;
        readonly ref: string;
        readonly commit: string;
        readonly retrieved: string;
      };
      readonly note?: string;
    };

/** What `NOTICES.json` records about an entry's upstream licence evidence. */
export type UpstreamLicenseRecord =
  | {
      readonly status: "vendored";
      readonly files: ReadonlyArray<
        Omit<VendoredLicenseFile, "file" | "sha256"> & { readonly graphPath: string }
      >;
      readonly note?: string;
    }
  | {
      readonly status: "no-license-file-upstream";
      readonly checked: Extract<VendoredLicensePackage, { checked: unknown }>["checked"];
      readonly note?: string;
    };

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const fileName = /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/;
const hex = /^[0-9a-f]{64}$/;
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export const vendoredDirectoryName = (name: string, version: string) =>
  `${name.replace("/", "+")}@${version}`;

function validate(manifest: unknown): ReadonlyArray<VendoredLicensePackage> {
  const value = manifest as { schemaVersion?: unknown; packages?: unknown };
  if (value?.schemaVersion !== 1 || !Array.isArray(value.packages))
    throw new Error("Vendored licence manifest has an unsupported schema.");
  const seen = new Set<string>();
  for (const pkg of value.packages as VendoredLicensePackage[]) {
    const key = `${pkg?.name}@${pkg?.version}`;
    if (!isText(pkg?.name) || !isText(pkg?.version) || seen.has(key))
      throw new Error(`Vendored licence manifest has an invalid or duplicate package: ${key}`);
    seen.add(key);
    if (pkg.status === "vendored") {
      if (!Array.isArray(pkg.files) || !pkg.files.length)
        throw new Error(`Vendored licences for ${key} list no files.`);
      const names = new Set<string>();
      for (const file of pkg.files)
        if (
          !fileName.test(file?.file ?? "") ||
          names.has(file.file) ||
          !hex.test(file.sha256 ?? "") ||
          !isText(file.sourceUrl) ||
          !isText(file.ref) ||
          !isText(file.path) ||
          !isText(file.retrieved)
        )
          throw new Error(`Vendored licence for ${key} has an invalid file record.`);
        else names.add(file.file);
    } else if (pkg.status === "no-license-file-upstream") {
      const checked = pkg.checked;
      if (!isText(checked?.repository) || !isText(checked.commit) || !isText(checked.retrieved))
        throw new Error(`Upstream check for ${key} is incomplete.`);
    } else throw new Error(`Vendored licence status for ${key} is unsupported.`);
  }
  return value.packages as VendoredLicensePackage[];
}

/** Read the manifest and verify every vendored file's bytes against its recorded hash. */
export async function loadVendoredLicenses(directory: string) {
  const packages = validate(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")));
  const sources = new Map<string, string>();
  for (const pkg of packages) {
    if (pkg.status !== "vendored") continue;
    for (const file of pkg.files) {
      const source = join(directory, vendoredDirectoryName(pkg.name, pkg.version), file.file);
      const bytes = await readFile(source).catch(() => {
        throw new Error(`Vendored licence file is missing: ${source}`);
      });
      if (sha256(bytes) !== file.sha256)
        throw new Error(`Vendored licence ${pkg.name}@${pkg.version}/${file.file} hash mismatch.`);
      sources.set(`${pkg.name}@${pkg.version}/${file.file}`, source);
    }
  }
  return { packages, sources };
}

/** A vendored file's source record, keyed by where it lands in the graph. */
function provenance(
  { file: _file, sha256: _sha, ...source }: VendoredLicenseFile,
  graphPath: string,
) {
  return { graphPath, ...source };
}

/** Attach vendored files and upstream checks to the matching name@version entries. Files are
 * appended after any file the package ships; graph copies land under `notices/vendored/`. */
export function applyVendoredLicenses(
  entries: ReadonlyArray<GraphNoticeEntry>,
  vendored: Awaited<ReturnType<typeof loadVendoredLicenses>>,
) {
  const byKey = new Map(vendored.packages.map((pkg) => [`${pkg.name}@${pkg.version}`, pkg]));
  const copies: { from: string; to: string }[] = [];
  const result = entries.map((entry): GraphNoticeEntry => {
    const key = `${entry.name}@${entry.version}`;
    const pkg = byKey.get(key);
    if (!pkg || entry.kind === "project" || entry.kind === "runtime") return entry;
    if (pkg.status === "no-license-file-upstream")
      return {
        ...entry,
        upstream: {
          status: pkg.status,
          checked: pkg.checked,
          ...(pkg.note ? { note: pkg.note } : {}),
        },
      };
    const prefix = posix.join(VENDORED_GRAPH_PREFIX, vendoredDirectoryName(pkg.name, pkg.version));
    const files = pkg.files.map((file) => {
      const graphPath = posix.join(prefix, file.file);
      if (!copies.some((copy) => copy.to === graphPath))
        copies.push({ from: vendored.sources.get(`${key}/${file.file}`)!, to: graphPath });
      return { file, graphPath };
    });
    return {
      ...entry,
      files: [
        ...entry.files,
        ...files.map(({ file, graphPath }) => ({ path: graphPath, sha256: file.sha256 })),
      ],
      upstream: {
        status: "vendored",
        files: files.map(({ file, graphPath }) => provenance(file, graphPath)),
        ...(pkg.note ? { note: pkg.note } : {}),
      },
    };
  });
  return { entries: result, copies };
}
