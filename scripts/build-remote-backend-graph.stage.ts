import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, posix, resolve } from "node:path";
import { isBackendGraphPath } from "../apps/server/src/remote-backend/backendGraph.manifest.ts";
import type { BackendGraphManifest } from "../apps/server/src/remote-backend/backendGraph.manifest.ts";
import { runArchive } from "./lib/remote-backend-control/archive.ts";
import type { ClosureEntry } from "./lib/remote-backend-control/closure.ts";
import { verifyExtractedClosure } from "./lib/remote-backend-control/verify.ts";
import type { BackendGraphClosureReport } from "./build-remote-backend-graph.closure.ts";
import {
  extractNodeRuntime,
  NODE_RUNTIME_VERSION,
  sha256File,
} from "./build-remote-backend-graph.externals.ts";
import { inventoryBackendGraph } from "./build-remote-backend-graph.inventory.ts";
import {
  collectBundledNotices,
  collectPackageNotices,
  noticeFiles,
  noticeSummary,
  type GraphNoticeEntry,
} from "./build-remote-backend-graph.notices.ts";
import {
  BACKEND_GRAPH_LOADER_POLICY,
  backendGraphLoaderPolicyDigest,
  type BackendGraphLoaderPolicy,
  type BackendGraphTarget,
} from "./build-remote-backend-graph.policy.ts";
import { buildRemoteBackendGraph } from "./build-remote-backend-graph.producer.ts";

export const GRAPH_NODE = "runtime/node";
export const GRAPH_ENTRY = "server/bin.mjs";
const forbidden = /^(?:\.env.*|\.git|\.npmrc|\.netrc|\.bigbud|\.config)$/;
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function copyPrivate(from: string, to: string) {
  const info = await lstat(from);
  if (!info.isFile()) throw new Error(`Graph input ${from} is not a regular file.`);
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  await copyFile(from, to, constants.COPYFILE_EXCL);
  await chmod(to, info.mode & 0o111 ? 0o700 : 0o600);
}

/** Copy a tree with private modes. Links, special files and non-graph names are refused, and
 * empty directories are skipped because the signed graph declares only files. */
async function copyTree(from: string, to: string, prefix: string) {
  for (const entry of (await readdir(from, { withFileTypes: true })).toSorted((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const path = posix.join(prefix, entry.name);
    if (forbidden.test(entry.name) || !isBackendGraphPath(path))
      throw new Error(`Graph input has a forbidden or invalid member path: ${path}`);
    if (entry.isDirectory()) await copyTree(join(from, entry.name), join(to, entry.name), path);
    else if (entry.isFile()) await copyPrivate(join(from, entry.name), join(to, entry.name));
    else throw new Error(`Graph input ${path} is a link or special file.`);
  }
}

async function privateDirectories(root: string): Promise<void> {
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true }))
    if (entry.isDirectory()) await privateDirectories(join(root, entry.name));
}

export interface AssembleBackendGraphInput {
  readonly target: BackendGraphTarget;
  /** Server build output with top-level `bin.mjs`, `NodeSqliteWorker.mjs` and the relay. */
  readonly dist: string;
  readonly nodeArchive: string;
  /** Tests only: substitute the Node runtime pin. */
  readonly nodePin?: { readonly name: string; readonly sha256: string };
  /** Installed, pruned target externals. */
  readonly nodeModules: string;
  readonly projectLicense: string;
  /** Workspace root holding the `node_modules/.bun` store named by the bundle regions. */
  readonly bundleSourceRoot?: string;
  /** Fresh directory; created private. */
  readonly graph: string;
}

/** Lay out `runtime/`, `server/`, `node_modules/` and notices in a fresh private root. */
export async function assembleBackendGraph(input: AssembleBackendGraphInput) {
  const graph = resolve(input.graph);
  await mkdir(graph, { mode: 0o700 });
  const extract = `${graph}.node-extract`;
  try {
    const runtime = await extractNodeRuntime({
      archive: input.nodeArchive,
      target: input.target,
      destination: extract,
      ...(input.nodePin ? { pin: input.nodePin } : {}),
    });
    await copyPrivate(runtime.node, join(graph, GRAPH_NODE));
    await chmod(join(graph, GRAPH_NODE), 0o700);
    await copyPrivate(runtime.license, join(graph, "runtime/LICENSE"));
    const bundleTexts: string[] = [];
    for (const [directory, prefix] of [
      ["", "server"],
      ["remote-client-relay", "server/remote-client-relay"],
    ] as const)
      for (const name of (await readdir(join(input.dist, directory))).toSorted())
        if (name.endsWith(".mjs") && isBackendGraphPath(name)) {
          const from = join(input.dist, directory, name);
          if (!(await lstat(from)).isFile()) continue;
          await copyPrivate(from, join(graph, prefix, name));
          bundleTexts.push(await readFile(from, "utf8"));
        }
    await copyTree(input.nodeModules, join(graph, "node_modules"), "node_modules");
    await copyPrivate(input.projectLicense, join(graph, "LICENSE"));
    const bundled = input.bundleSourceRoot
      ? await collectBundledNotices({ workspaceRoot: input.bundleSourceRoot, bundleTexts })
      : { entries: [], copies: [] };
    for (const copy of bundled.copies) await copyPrivate(copy.from, join(graph, copy.to));
    const notices: GraphNoticeEntry[] = [
      {
        kind: "project",
        name: "bigbud",
        version: "",
        license: "MIT",
        directory: "",
        files: await noticeFiles(graph, ""),
      },
      {
        kind: "runtime",
        name: "node",
        version: NODE_RUNTIME_VERSION,
        license: null,
        directory: "runtime",
        files: (await noticeFiles(join(graph, "runtime"), "runtime")).filter((f) =>
          f.path.endsWith("LICENSE"),
        ),
      },
      ...bundled.entries,
      ...(await collectPackageNotices(graph)),
    ];
    const noticeJson = `${JSON.stringify({ schemaVersion: 1, entries: notices }, null, 2)}\n`;
    await writeFile(join(graph, "NOTICES.json"), noticeJson, { flag: "wx", mode: 0o600 });
    await privateDirectories(graph);
    return {
      graph,
      nodeArchiveSha256: runtime.archiveSha256,
      noticesSha256: sha256(noticeJson),
      notices: noticeSummary(notices),
    };
  } finally {
    await rm(extract, { recursive: true, force: true });
  }
}

export interface StageBackendGraphInput extends Omit<AssembleBackendGraphInput, "graph"> {
  readonly version: string;
  readonly externals: {
    readonly lockSha256: string;
    readonly skippedInstallScripts: ReadonlyArray<string>;
    readonly pruned: number;
  };
  readonly sourceRevision?: string;
  /** Fresh output directory; receives `graph/`, `manifest.json`, the archive and provenance. */
  readonly output: string;
  readonly keyFile: string;
  readonly keyId: string;
  readonly policy?: BackendGraphLoaderPolicy;
}

/** Assemble, sign with the existing producer, archive deterministically and verify extraction. */
export async function stageRemoteBackendGraph(input: StageBackendGraphInput) {
  const parent = await realpath(dirname(resolve(input.output)));
  const output = join(parent, basename(input.output));
  await mkdir(output, { mode: 0o700 });
  await chmod(output, 0o700);
  const policy = input.policy ?? BACKEND_GRAPH_LOADER_POLICY;
  const assembled = await assembleBackendGraph({ ...input, graph: join(output, "graph") });
  const files = await inventoryBackendGraph(assembled.graph);
  const inventorySha256 = sha256(
    files.map((f) => `${f.path}\0${f.sha256}\0${f.executable}\n`).join(""),
  );
  const buildInputs = {
    schema: "bigbud.remote-backend.graph-build.v1",
    target: input.target,
    version: input.version,
    node: { version: NODE_RUNTIME_VERSION, archiveSha256: assembled.nodeArchiveSha256 },
    externals: input.externals,
    loaderPolicySha256: backendGraphLoaderPolicyDigest(policy),
    noticesSha256: assembled.noticesSha256,
    inventorySha256,
    sourceRevision: input.sourceRevision ?? null,
  };
  const buildDigest = sha256(JSON.stringify(buildInputs));
  let closure: BackendGraphClosureReport | undefined;
  const manifestPath = join(output, "manifest.json");
  const manifest: BackendGraphManifest = await buildRemoteBackendGraph({
    root: assembled.graph,
    version: input.version,
    buildDigest,
    target: input.target,
    node: GRAPH_NODE,
    entry: GRAPH_ENTRY,
    keyFile: input.keyFile,
    keyId: input.keyId,
    output: manifestPath,
    loaderPolicy: policy,
    onClosureReport: (report) => (closure = report),
  });
  const directories = new Set<string>();
  for (const file of manifest.files) {
    const parts = file.path.split("/");
    for (let n = 1; n < parts.length; n++) directories.add(parts.slice(0, n).join("/"));
  }
  const entries: ClosureEntry[] = [
    ...[...directories].map((path) => ({ path, kind: "directory" as const, mode: 0o700 })),
    ...manifest.files.map((file) => ({
      path: file.path,
      kind: "file" as const,
      mode: file.executable ? 0o700 : 0o600,
      size: file.sizeBytes,
      sha256: file.sha256,
      source: join(assembled.graph, file.path),
    })),
  ].toSorted((a, b) => (a.path < b.path ? -1 : 1));
  const archiveName = `bigbud-backend-graph-${input.version}-${input.target}.tar.gz`;
  const archive = join(output, archiveName);
  const tooling = runArchive({ action: "create", entries, archive });
  const extracted = join(output, "extract-check");
  try {
    runArchive({ action: "extract", entries, archive, destination: extracted });
    await verifyExtractedClosure(extracted, entries);
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }
  const archiveSha256 = await sha256File(archive);
  const provenance = {
    schemaVersion: 1,
    purpose: "remote-backend-executable-graph",
    buildDigest,
    buildInputs,
    tooling,
    manifest: { sha256: await sha256File(manifestPath), keyId: input.keyId },
    graph: {
      files: manifest.files.length,
      bytes: manifest.files.reduce((total, file) => total + file.sizeBytes, 0),
      node: GRAPH_NODE,
      entry: GRAPH_ENTRY,
    },
    closure: closure && { ...closure, unreviewedSites: undefined, problems: undefined },
    notices: assembled.notices,
    archive: { name: archiveName, sizeBytes: (await stat(archive)).size, sha256: archiveSha256 },
    extractionVerified: true,
  };
  await writeFile(join(output, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return { output, graph: assembled.graph, manifest, provenance };
}
