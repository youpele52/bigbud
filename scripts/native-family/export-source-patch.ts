import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertNativeFamilyModuleInventory,
  NATIVE_FAMILY_BASELINE,
  writeNativeFamilyModule,
} from "./export-source-patch.artifacts.ts";

// Reproducible SOURCE export only. Never builds/starts OpenCode, installs config,
// stages changes, or manufactures executable qualification evidence.
const baseline = NATIVE_FAMILY_BASELINE;
const source = process.argv[2];
if (!source || source.startsWith("-"))
  throw new Error(
    "Pass the isolated OpenCode v2.0.26 source checkout path; repo-only hygiene uses normalize-artifacts.ts.",
  );
const git = (...args: string[]) => execFileSync("git", args, { cwd: source, encoding: "utf8" });
if (git("rev-parse", "HEAD").trim() !== baseline)
  throw new Error("Native family patch base mismatch.");
execFileSync(process.execPath, ["run", "packages/core/script/family-source.ts"], { cwd: source });
const changedSources = new Set(
  [
    ...git("diff", "--name-only", "--", "packages").trim().split("\n"),
    ...git("ls-files", "--others", "--exclude-standard", "--", "packages").trim().split("\n"),
  ].filter((file) => /\.(?:ts|tsx|js|mjs|rs)$/.test(file)),
);
for (const file of changedSources) {
  const content = await readFile(path.join(source, file), "utf8");
  if (content.trimEnd().split("\n").length > 400)
    throw new Error(
      `Materially changed native source exceeds 400 lines; extract its concern: ${file}`,
    );
}
const project = path.resolve(import.meta.dirname, "../..");
const output = path.join(project, "patches/opencode-native-family-v1");
await mkdir(output, { recursive: true });
let patch = git("diff", "--no-ext-diff", "--binary", "--", "packages");
for (const filename of git("ls-files", "--others", "--exclude-standard", "--", "packages")
  .trim()
  .split("\n")
  .filter(Boolean)
  .toSorted()) {
  if (!/\.(?:ts|mjs)$/.test(filename))
    throw new Error(`Unexpected native source artifact: ${filename}`);
  const lines = (await readFile(path.join(source, filename), "utf8")).trimEnd().split("\n");
  patch += `diff --git a/${filename} b/${filename}\nnew file mode 100644\n--- /dev/null\n+++ b/${filename}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
}
await writeFile(path.join(project, "patches/opencode@2.0.26-native-family-v1.patch"), patch);
// Compile ONLY the pure ledger/receipt modules for scripted source-unit hosts. No Core graph,
// server, native executable, SDK host or provider is imported/evaluated here.
const built = await Bun.build({
  entrypoints: ["family.ledger.ts", "family.receipt.ts"].map((file) =>
    path.join(source, "packages/core/src/session", file),
  ),
  target: "node",
  packages: "external",
  splitting: true,
  naming: { entry: "[name].mjs", chunk: "receipt-shared.mjs" },
});
if (!built.success) throw new Error(`Native source bundle failed: ${built.logs.join("\n")}`);
const modules: Record<string, string> = {};
const moduleName = (filename: string) =>
  path.basename(filename).replace("family.ledger.mjs", "ledger.mjs");
assertNativeFamilyModuleInventory(built.outputs.map((artifact) => moduleName(artifact.path)));
for (const artifact of built.outputs) {
  const name = moduleName(artifact.path);
  modules[name] = await writeNativeFamilyModule(project, name, await artifact.text());
}
const stamp = await readFile(
  path.join(source, "packages/core/src/session/family.source.ts"),
  "utf8",
);
const sourceDigest = stamp.match(/"([a-f0-9]{64})"/)?.[1];
if (!sourceDigest) throw new Error("Run the native source identity generator first.");
await writeFile(
  path.join(output, "manifest.json"),
  JSON.stringify(
    {
      abi: "opencode.native-family.v1",
      baseline,
      sourceDigest,
      patchSha256: createHash("sha256").update(patch).digest("hex"),
      ledgerSha256: createHash("sha256")
        .update(await readFile(path.join(output, "ledger.mjs")))
        .digest("hex"),
      modules,
      evidenceKind: "source-unit-only",
      nativeQualification: false,
    },
    null,
    2,
  ) + "\n",
);
