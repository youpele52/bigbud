import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { BackendGraphTarget } from "./build-remote-backend-graph.policy.ts";

/** Node runtime pins from https://nodejs.org/dist/v24.13.1/SHASUMS256.txt (17 Nov 2026). */
export const NODE_RUNTIME_VERSION = "24.13.1";
export const NODE_RUNTIME_PINS: Readonly<
  Record<BackendGraphTarget, { readonly name: string; readonly sha256: string }>
> = {
  "aarch64-unknown-linux-gnu": {
    name: "node-v24.13.1-linux-arm64",
    sha256: "c827d3d301e2eed1a51f36d0116b71b9e3d9e3b728f081615270ea40faac34c1",
  },
  "x86_64-unknown-linux-gnu": {
    name: "node-v24.13.1-linux-x64",
    sha256: "30215f90ea3cd04dfbc06e762c021393fa173a1d392974298bbc871a8e461089",
  },
};
export const nodeRuntimeUrl = (target: BackendGraphTarget) =>
  `https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}/${NODE_RUNTIME_PINS[target].name}.tar.xz`;
/** Packages whose npm install scripts are skipped. Each was reviewed as unnecessary with
 * prebuilt payloads: koffi uses the @koromix platform package; @google/genai and protobufjs
 * scripts are postinstall notices or optional codegen. A new script-bearing package fails. */
export const REVIEWED_SKIPPED_INSTALL_SCRIPTS = ["@google/genai", "koffi", "protobufjs"] as const;

export const npmArch = (target: BackendGraphTarget) =>
  target.startsWith("aarch64") ? "arm64" : "x64";

export async function sha256File(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Download into a fresh private directory, then refuse anything but the pinned bytes. */
export async function downloadNodeRuntime(target: BackendGraphTarget, directory: string) {
  await mkdir(directory, { mode: 0o700 });
  const archive = join(directory, `${NODE_RUNTIME_PINS[target].name}.tar.xz`);
  const response = await fetch(nodeRuntimeUrl(target), { redirect: "error" });
  if (!response.ok) throw new Error("Node runtime download failed.");
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > 128 * 1024 * 1024) throw new Error("Node runtime download is oversized.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== NODE_RUNTIME_PINS[target].sha256)
    throw new Error("Node runtime archive does not match its pinned SHA-256.");
  await writeFile(archive, bytes, { flag: "wx", mode: 0o600 });
  return archive;
}

/** Verify the pin, then extract only `bin/node` and `LICENSE` into a fresh directory. */
export async function extractNodeRuntime(input: {
  archive: string;
  target: BackendGraphTarget;
  destination: string;
  pin?: { readonly name: string; readonly sha256: string };
}) {
  const pin = input.pin ?? NODE_RUNTIME_PINS[input.target];
  const archiveSha256 = await sha256File(input.archive);
  if (archiveSha256 !== pin.sha256)
    throw new Error("Node runtime archive does not match its pinned SHA-256.");
  await mkdir(input.destination, { mode: 0o700 });
  const members = [`${pin.name}/bin/node`, `${pin.name}/LICENSE`];
  const result = spawnSync("tar", ["-xJf", input.archive, "-C", input.destination, ...members], {
    encoding: "utf8",
    timeout: 5 * 60 * 1000,
  });
  if (result.status !== 0) throw new Error(`Node runtime extraction failed: ${result.stderr}`);
  const node = join(input.destination, members[0]!),
    license = join(input.destination, members[1]!);
  for (const path of [node, license])
    if (!(await lstat(path)).isFile()) throw new Error("Node runtime member is not a file.");
  return { node, license, archiveSha256 };
}

const lifecycle = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "preprepare",
  "postprepare",
]);
/** The pinned root manifest must never declare scripts; npm runs them even when dependencies'
 * scripts are skipped in some modes. */
export function assertNoLifecycleScripts(manifest: Record<string, unknown>) {
  const scripts = manifest.scripts;
  if (scripts !== undefined && (typeof scripts !== "object" || scripts === null))
    throw new Error("Graph externals manifest has invalid scripts.");
  if (scripts && Object.keys(scripts).length)
    throw new Error(
      `Graph externals manifest must not declare scripts (${
        Object.keys(scripts)
          .filter((k) => lifecycle.has(k))
          .join(", ") || "any"
      }).`,
    );
}

/** Every locked package with an install script must be a reviewed skip. */
export function auditSkippedInstallScripts(lock: { packages?: Record<string, unknown> }) {
  const skipped: string[] = [];
  for (const [path, value] of Object.entries(lock.packages ?? {})) {
    if (!path || !(value as { hasInstallScript?: boolean }).hasInstallScript) continue;
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    if (!(REVIEWED_SKIPPED_INSTALL_SCRIPTS as readonly string[]).includes(name))
      throw new Error(`Unreviewed install script in graph externals: ${name}.`);
    skipped.push(name);
  }
  return skipped.toSorted();
}

export function npmCiArgs(target: BackendGraphTarget, userConfig: string) {
  return [
    "ci",
    "--ignore-scripts",
    "--omit=dev",
    "--os=linux",
    `--cpu=${npmArch(target)}`,
    "--libc=glibc",
    "--no-bin-links",
    "--no-audit",
    "--no-fund",
    "--no-update-notifier",
    `--userconfig=${userConfig}`,
  ];
}

/** Install the pinned lock for one target. Lifecycle scripts never run. */
export async function installGraphExternals(input: {
  externalsDirectory: string;
  target: BackendGraphTarget;
  directory: string;
}) {
  await mkdir(input.directory, { mode: 0o700 });
  const manifest = JSON.parse(
    await readFile(join(input.externalsDirectory, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  assertNoLifecycleScripts(manifest);
  const lockText = await readFile(join(input.externalsDirectory, "package-lock.json"), "utf8");
  const skippedInstallScripts = auditSkippedInstallScripts(JSON.parse(lockText));
  for (const name of ["package.json", "package-lock.json"])
    await copyFile(join(input.externalsDirectory, name), join(input.directory, name));
  const userConfig = join(input.directory, "empty.npmrc");
  await writeFile(userConfig, "", { mode: 0o600 });
  const result = spawnSync("npm", npmCiArgs(input.target, userConfig), {
    cwd: input.directory,
    encoding: "utf8",
    timeout: 15 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, npm_config_ignore_scripts: "true", npm_config_audit: "false" },
  });
  if (result.status !== 0) throw new Error(`npm ci failed: ${result.stderr.slice(-2000)}`);
  await rm(userConfig);
  return {
    nodeModules: join(input.directory, "node_modules"),
    lockSha256: createHash("sha256").update(lockText).digest("hex"),
    skippedInstallScripts,
  };
}

/** Deterministic target pruning: other-platform native payloads, musl addons on a glibc graph,
 * source maps and type declarations outside packages that ship them as runtime assets. */
export function prunePlan(target: BackendGraphTarget) {
  const arch = npmArch(target),
    other = arch === "arm64" ? "x64" : "arm64";
  return {
    directories: [
      "@earendil-works/pi-tui/native/darwin",
      "@earendil-works/pi-tui/native/win32",
      `@earendil-works/pi-tui/native/linux/prebuilds/linux-${other}`,
      `@koromix/koffi-linux-${arch}/musl_${arch}`,
      `@github/copilot-sdk-linux-${arch}/ripgrep/bin/linux-${other}`,
      `@github/copilot-sdk-linux-${arch}/tgrep/bin/linux-${other}`,
    ],
    fileSuffixes: [".map", ".d.ts", ".d.mts", ".d.cts"],
    keepFilesUnder: ["@earendil-works/pi-coding-agent/", `@github/copilot-sdk-linux-${arch}/`],
  };
}

export async function pruneGraphExternals(nodeModules: string, target: BackendGraphTarget) {
  const plan = prunePlan(target);
  const removed: string[] = [];
  for (const directory of plan.directories) {
    const path = join(nodeModules, directory);
    if (!(await lstat(path).catch(() => undefined))?.isDirectory()) continue;
    await rm(path, { recursive: true });
    removed.push(`${directory}/`);
  }
  async function visit(relative: string): Promise<void> {
    for (const entry of (
      await readdir(join(nodeModules, relative), { withFileTypes: true })
    ).toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = relative ? posix.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) await visit(child);
      else if (
        plan.fileSuffixes.some((suffix) => entry.name.endsWith(suffix)) &&
        !plan.keepFilesUnder.some((prefix) => child.startsWith(prefix))
      ) {
        await rm(join(nodeModules, child));
        removed.push(child);
      }
    }
  }
  await visit("");
  return removed;
}
