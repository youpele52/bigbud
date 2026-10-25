import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inputs, sourceManifest, buildHash, hash } from "./checkpoint.extension.artifacts.mjs";
import { installedCompilerFingerprint, buildOptions } from "./checkpoint.extension.toolchain.mjs";

const directory = resolve(process.argv[2]);
const deriveOnly = process.argv[3] === "--derive-only";
if (process.argv[3] !== undefined && !deriveOnly)
  throw new Error("unknown experiment generation mode");
const toolchain = installedCompilerFingerprint(typeof Bun === "undefined" ? undefined : Bun);
const sources = sourceManifest();
for (const { name } of sources) {
  if (readFileSync(new URL(name, import.meta.url), "utf8").split("\n").length > 400)
    throw new Error(`owned source ${name} exceeds line limit`);
}
const build = buildHash(sources, toolchain);
const bundled = await Bun.build({
  entrypoints: [fileURLToPath(new URL("checkpoint.extension.entry.mjs", import.meta.url))],
  ...buildOptions,
});
if (!bundled.success || bundled.outputs.length !== 1)
  throw new Error("experimental extension build failed");
const extension = await bundled.outputs[0].text();
const manifest = {
  schema: 3,
  build,
  bundler: Bun.version,
  toolchain,
  exactCapability: false,
  inputs,
  sources: sources.map(({ name, sha256 }) => ({ name, sha256 })),
  outputs: {},
};
for (const [kind, digest] of Object.entries(inputs)) {
  const base = readFileSync(resolve(directory, `${kind}.cjs`), "utf8");
  if (hash(base) !== digest) throw new Error(`unverified ${kind} input`);
  const artifact = `${base}\n;globalThis.__bigbudCheckpointExperimentTarget = typeof module === "object" ? module.exports : globalThis;\nglobalThis.__bigbudCheckpointExperimentBuild = ${JSON.stringify(build)};\n${extension}\ndelete globalThis.__bigbudCheckpointExperimentTarget;\ndelete globalThis.__bigbudCheckpointExperimentBuild;\n`;
  if (artifact.split("\n").length > 400)
    throw new Error("experimental output exceeds source-boundary line limit");
  if (!deriveOnly) writeFileSync(resolve(directory, `${kind}.experimental.cjs`), artifact);
  manifest.outputs[kind] = hash(artifact);
}
if (!deriveOnly)
  writeFileSync(resolve(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
