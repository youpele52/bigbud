import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { createRequire } from "node:module";
import { executeOwnedNode } from "../lib/checkpoint-node-tests.process.ts";
import { compilerCommand, projectCompilerPolicy } from "./checkpoint.extension.toolchain.mjs";

export const inputs = {
  headless: "17a90b650cf6b77cce2b98c4063884d43545e4ce177a54b76ccfc906f1aacaed",
  browser: "14903579ff54664cd72f8e8699e6961a6272c21863ec1c3b118cdc8af5d4a972",
};
export const sourceNames = [
  "codec",
  "pages",
  "page-custody",
  "schema",
  "digest",
  "budget",
  "state",
  "validation",
  "",
  "entry",
  "generate",
  "artifacts",
  "toolchain",
]
  .map((part) => `checkpoint.extension${part ? `.${part}` : ""}.mjs`)
  .concat(["../lib/checkpoint-node-tests.process.ts", "../lib/checkpoint-node-tests.windows.ts"]);
export const hash = (source) => createHash("sha256").update(source).digest("hex");
export const sourceManifest = () =>
  sourceNames.map((name) => ({ name, sha256: hash(readFileSync(new URL(name, import.meta.url))) }));
export const buildHash = (sources, toolchain) =>
  hash(JSON.stringify({ expected: inputs, sources, toolchain }));
const verifiedSources = new WeakMap();

export async function verifyArtifacts(directory) {
  const manifest = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8"));
  const sources = sourceManifest();
  if (
    manifest.schema !== 3 ||
    manifest.exactCapability !== false ||
    JSON.stringify(manifest.sources) !== JSON.stringify(sources) ||
    JSON.stringify(manifest.inputs) !== JSON.stringify(inputs)
  )
    throw new Error("invalid experimental manifest");
  for (const kind of ["headless", "browser"]) {
    if (hash(readFileSync(resolve(directory, `${kind}.cjs`))) !== inputs[kind])
      throw new Error(`unverified ${kind} input`);
  }
  // The adjacent manifest is NOT an execution authority. Rebuild hashes in a
  // read-only child from trusted repository source + pinned inputs/toolchain.
  // This mode never loads the candidate artifacts or rewrites the experiment.
  const { stdout } = await executeOwnedNode(
    [
      "--no-install",
      "run",
      fileURLToPath(new URL("checkpoint.extension.generate.mjs", import.meta.url)),
      directory,
      "--derive-only",
    ],
    {
      command: compilerCommand(),
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      timeoutMs: 30000,
      maxBuffer: 1024 * 1024,
      inheritOwnerGroup:
        /^[a-f0-9]{64}$/.test(process.env.BIGBUD_CHECKPOINT_FIXTURE_TICKET ?? "") &&
        process.env.BIGBUD_CHECKPOINT_OWNED_TREE === process.env.BIGBUD_CHECKPOINT_FIXTURE_TICKET,
    },
  );
  const derived = JSON.parse(stdout);
  if (
    derived.build !== buildHash(sources, derived.toolchain) ||
    JSON.stringify(derived.toolchain?.policy) !== JSON.stringify(projectCompilerPolicy()) ||
    derived.bundler !== derived.toolchain?.version ||
    JSON.stringify(derived.sources) !== JSON.stringify(sources)
  )
    throw new Error("reviewed experiment source changed during derivation");
  if (
    manifest.build !== derived.build ||
    manifest.bundler !== derived.bundler ||
    JSON.stringify(manifest.toolchain) !== JSON.stringify(derived.toolchain)
  )
    throw new Error("invalid experimental manifest compiler fingerprint");
  const code = {};
  for (const kind of ["headless", "browser"]) {
    const bytes = readFileSync(resolve(directory, `${kind}.experimental.cjs`));
    if (hash(bytes) !== derived.outputs[kind] || manifest.outputs?.[kind] !== derived.outputs[kind])
      throw new Error(`experimental ${kind} reviewed source-derived output mismatch`);
    code[kind] = bytes.toString("utf8");
  }
  // Execution uses these immutable verified strings, never a later file read.
  verifiedSources.set(manifest, code);
  return manifest;
}

export function verifiedArtifactSource(verification, kind) {
  const code = verifiedSources.get(verification)?.[kind];
  if (code === undefined) throw new Error("artifact execution requires trusted verification");
  return code;
}

export function loadVerifiedHeadless(verification) {
  const source = verifiedArtifactSource(verification, "headless");
  const module = { exports: {} };
  new Script(`(function(module, exports, require) {\n${source}\n})`, {
    filename: "verified-headless.experimental.cjs",
  }).runInThisContext()(module, module.exports, createRequire(import.meta.url));
  return module.exports;
}
