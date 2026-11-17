import { spawnSync } from "node:child_process";
import { mkdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { validateBackendGraphClosure } from "./build-remote-backend-graph.closure.ts";
import {
  downloadNodeRuntime,
  installGraphExternals,
  pruneGraphExternals,
} from "./build-remote-backend-graph.externals.ts";
import { inventoryBackendGraph } from "./build-remote-backend-graph.inventory.ts";
import type { BackendGraphTarget } from "./build-remote-backend-graph.policy.ts";
import { backendGraphRequiredRoots } from "./build-remote-backend-graph.producer.ts";
import {
  assembleBackendGraph,
  GRAPH_ENTRY,
  stageRemoteBackendGraph,
} from "./build-remote-backend-graph.stage.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage =
  "Usage: remote-backend-graph --target <aarch64-unknown-linux-gnu|x86_64-unknown-linux-gnu> " +
  "--dist <server-dist> --output <fresh-dir> --key-file <ed25519-pem> --key-id <id> " +
  "--version <version> [--work <fresh-dir>] [--node-archive <tar.xz>] [--keep-work] " +
  "[--list-loader-sites]\n" +
  "Downloads the pinned Node runtime, installs the pinned Linux externals with lifecycle " +
  "scripts disabled, assembles a private graph, signs it with the given key, writes a " +
  "deterministic archive and provenance.json, and verifies extraction. Use a fixture/dev key; " +
  "this command never publishes or installs anything on a host.";

export async function main(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      target: { type: "string" },
      dist: { type: "string" },
      output: { type: "string" },
      "key-file": { type: "string" },
      "key-id": { type: "string" },
      version: { type: "string" },
      work: { type: "string" },
      "node-archive": { type: "string" },
      "keep-work": { type: "boolean" },
      "list-loader-sites": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return console.log(usage);
  const target = values.target as BackendGraphTarget | undefined;
  if (target !== "aarch64-unknown-linux-gnu" && target !== "x86_64-unknown-linux-gnu")
    throw new Error("--target must be a supported Linux GNU target.");
  if (!values.dist || !values.output) throw new Error(usage);
  const listing = values["list-loader-sites"] === true;
  if (!listing && (!values["key-file"] || !values["key-id"] || !values.version))
    throw new Error("--key-file, --key-id and --version are required to sign.");
  const output = join(await realpath(dirname(resolve(values.output))), basename(values.output));
  const work = values.work ? resolve(values.work) : `${output}.work`;
  await mkdir(work, { mode: 0o700 });
  try {
    const nodeArchive = values["node-archive"]
      ? resolve(values["node-archive"])
      : await downloadNodeRuntime(target, join(work, "node"));
    const externals = await installGraphExternals({
      externalsDirectory: join(repo, "scripts/remote-backend-graph"),
      target,
      directory: join(work, "externals"),
    });
    const pruned = await pruneGraphExternals(externals.nodeModules, target);
    const common = {
      target,
      dist: resolve(values.dist),
      nodeArchive,
      nodeModules: externals.nodeModules,
      projectLicense: join(repo, "LICENSE"),
      bundleSourceRoot: repo,
    };
    if (listing) return await listLoaderSites({ ...common, graph: output });
    const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
    const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    const result = await stageRemoteBackendGraph({
      ...common,
      version: values.version!,
      externals: {
        lockSha256: externals.lockSha256,
        skippedInstallScripts: externals.skippedInstallScripts,
        pruned: pruned.length,
      },
      ...(revision.status === 0
        ? { sourceRevision: `${revision.stdout.trim()}${dirty.stdout.trim() ? "+dirty" : ""}` }
        : {}),
      output,
      keyFile: resolve(values["key-file"]!),
      keyId: values["key-id"]!,
    });
    const { graph, archive, buildDigest, closure } = result.provenance;
    console.log(
      JSON.stringify({ output: result.output, buildDigest, graph, archive, closure }, null, 2),
    );
  } finally {
    if (!values["keep-work"]) await rm(work, { recursive: true, force: true });
  }
}

/** Assemble without signing and print every unreviewed loader site or refusal. */
async function listLoaderSites(input: Parameters<typeof assembleBackendGraph>[0]) {
  const assembled = await assembleBackendGraph(input);
  const report = await validateBackendGraphClosure(
    assembled.graph,
    await inventoryBackendGraph(assembled.graph),
    {
      entry: GRAPH_ENTRY,
      target: input.target,
      roots: backendGraphRequiredRoots(GRAPH_ENTRY),
      listUnreviewedSites: true,
    },
  );
  for (const site of report.unreviewedSites)
    console.log(`${site.kind}\t${site.member}\t${site.sha256}\t${site.from}\t${site.excerpt}`);
  for (const problem of report.problems) console.log(`refusal\t${problem}`);
  console.log(
    `${report.unreviewedSites.length} unreviewed sites, ${report.problems.length} refusals; ` +
      `${report.reachableModules} reachable modules. Unsigned graph left at ${assembled.graph}.`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
