import { builtinModules } from "node:module";
import { join, posix } from "node:path";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { readStableFile } from "./lib/artifact-build/io.ts";
import type { BackendGraphFile } from "../apps/server/src/remote-backend/backendGraph.manifest.ts";
import {
  BACKEND_GRAPH_LOADER_POLICY,
  isAbsentOptionalExternal,
  type BackendGraphLoaderPolicy,
  type BackendGraphTarget,
} from "./build-remote-backend-graph.policy.ts";
import {
  parseGraphModule,
  type GraphEdge,
  type GraphModule,
  type LoaderSite,
} from "./build-remote-backend-graph.reachability.ts";
import { resolveGraphSpecifier } from "./build-remote-backend-graph.resolve.ts";

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
for (const name of ["node:sqlite", "node:sea", "node:test", "node:test/reporters"])
  builtins.add(name);
const script = /\.(?:cjs|mjs|js)$/;
const machine = { "aarch64-unknown-linux-gnu": 183, "x86_64-unknown-linux-gnu": 62 } as const;

export interface BackendGraphClosureOptions {
  readonly entry: string;
  readonly target: BackendGraphTarget;
  /** Additional roots that start eagerly (worker threads, helper processes). */
  readonly roots?: ReadonlyArray<string>;
  readonly policy?: BackendGraphLoaderPolicy;
  /** Report unreviewed loader sites instead of refusing them; never used when signing. */
  readonly listUnreviewedSites?: boolean;
}
export interface BackendGraphClosureReport {
  readonly reachableModules: number;
  readonly staticModules: number;
  readonly reviewedSites: number;
  readonly absentOptional: ReadonlyArray<{ readonly from: string; readonly specifier: string }>;
  readonly nativeAddons: ReadonlyArray<string>;
  readonly unreviewedSites: ReadonlyArray<LoaderSite & { readonly from: string }>;
  /** Listing mode only: refusals that would otherwise stop validation. */
  readonly problems: ReadonlyArray<string>;
}

async function elfMachine(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(20);
    const { bytesRead } = await file.read(bytes, 0, 20, 0);
    if (bytesRead < 4 || bytes.subarray(0, 4).toString("hex") !== "7f454c46") return undefined;
    if (bytesRead !== 20 || bytes[4] !== 2 || bytes[5] !== 1) return -1;
    return bytes.readUInt16LE(18);
  } finally {
    await file.close();
  }
}

/** Reachability-aware static closure validation; never executes graph files. Bundle-owned
 * scripts (everything outside node_modules) are always validated; node_modules scripts are
 * validated when any literal edge or reviewed loader root reaches them. */
export async function validateBackendGraphClosure(
  root: string,
  files: ReadonlyArray<BackendGraphFile>,
  options: BackendGraphClosureOptions,
): Promise<BackendGraphClosureReport> {
  const policy = options.policy ?? BACKEND_GRAPH_LOADER_POLICY;
  const members = new Map(files.map((file) => [file.path, file]));
  const memberSet = new Set(members.keys());
  async function read(path: string) {
    const read = await readStableFile(join(root, path), 64 * 1024 * 1024);
    if (read.sha256 !== members.get(path)?.sha256)
      throw new Error("Graph source changed before closure validation.");
    return read.bytes.toString("utf8");
  }
  const packages = new Map<string, Record<string, unknown>>();
  for (const path of memberSet)
    if (posix.basename(path) === "package.json")
      try {
        packages.set(path, JSON.parse(await read(path)) as Record<string, unknown>);
      } catch (cause) {
        if (cause instanceof SyntaxError) continue;
        throw cause;
      }
  const context = { members: memberSet, readPackageJson: (path: string) => packages.get(path) };
  const staticRoots = new Set([options.entry, ...(options.roots ?? [])]);
  for (const path of staticRoots)
    if (!memberSet.has(path)) throw new Error(`Graph root ${path} is not a member.`);
  const queue = [
    ...staticRoots,
    ...[...memberSet].filter((path) => script.test(path) && !path.startsWith("node_modules/")),
  ];
  const modules = new Map<string, GraphModule>();
  const resolved = new Map<string, Map<GraphEdge, string | undefined>>();
  const unreviewed: (LoaderSite & { from: string })[] = [];
  let reviewedSites = 0;
  while (queue.length) {
    const path = queue.pop()!;
    if (modules.has(path)) continue;
    const module = parseGraphModule(path, await read(path));
    modules.set(path, module);
    const targets = new Map<GraphEdge, string | undefined>();
    for (const edge of module.edges) {
      if (builtins.has(edge.specifier)) continue;
      const mode =
        edge.kind === "require" || edge.kind === "require-resolve" ? "require" : "import";
      const target = resolveGraphSpecifier(context, path, edge.specifier, mode);
      targets.set(edge, target);
      if (target && script.test(target)) queue.push(target);
    }
    resolved.set(path, targets);
    for (const site of module.sites) {
      const review = policy.reviewedDynamicLoaders.find(
        (entry) => entry.member === site.member && entry.sha256 === site.sha256,
      );
      if (!review) {
        unreviewed.push({ ...site, from: path });
        continue;
      }
      reviewedSites++;
      for (const extra of review.roots) {
        if (!memberSet.has(extra))
          throw new Error(`Reviewed loader root ${extra} is missing from the graph.`);
        staticRoots.add(extra);
        queue.push(extra);
      }
    }
  }
  if (unreviewed.length && !options.listUnreviewedSites) {
    const first = unreviewed[0]!;
    throw new Error(
      `Unsupported dynamic/native loader closure requires separate qualification: ${first.kind} ` +
        `in ${first.from} (member ${first.member}, sha256 ${first.sha256}).`,
    );
  }
  const staticReachable = new Set<string>();
  const pending = [...staticRoots];
  while (pending.length) {
    const path = pending.pop()!;
    if (staticReachable.has(path)) continue;
    staticReachable.add(path);
    for (const [edge, target] of resolved.get(path) ?? [])
      if (edge.eager && target && script.test(target)) pending.push(target);
  }
  const absentOptional: { from: string; specifier: string }[] = [];
  const problems: string[] = [];
  const refuse = (problem: string) => {
    if (!options.listUnreviewedSites) throw new Error(problem);
    problems.push(problem);
  };
  for (const [from, targets] of resolved)
    for (const [edge, target] of targets) {
      if (target) continue;
      if (!isAbsentOptionalExternal(policy, edge.specifier)) {
        refuse(`Graph has an unresolved dependency ${edge.specifier} in ${from}.`);
        continue;
      }
      if (edge.eager && staticReachable.has(from))
        refuse(`Absent optional external ${edge.specifier} is statically reachable from ${from}.`);
      absentOptional.push({ from, specifier: edge.specifier });
    }
  const nativeAddons: string[] = [];
  for (const path of memberSet) {
    const found = await elfMachine(join(root, path));
    if (path.endsWith(".node")) {
      if (
        !policy.nativeAddons.some((addon) => addon.path === path && addon.target === options.target)
      )
        refuse(`Native addon ${path} is not listed for ${options.target}.`);
      else if (found !== machine[options.target])
        refuse(`Native addon ${path} does not match the ${options.target} ELF machine.`);
      else nativeAddons.push(path);
    } else if (found !== undefined && found !== machine[options.target])
      refuse(`Graph ELF member ${path} does not match the ${options.target} machine.`);
  }
  return {
    reachableModules: modules.size,
    staticModules: staticReachable.size,
    reviewedSites,
    absentOptional: absentOptional.toSorted((a, b) =>
      `${a.from}\0${a.specifier}` < `${b.from}\0${b.specifier}` ? -1 : 1,
    ),
    nativeAddons: nativeAddons.toSorted(),
    unreviewedSites: unreviewed,
    problems,
  };
}
