import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  V2_NATIVE_RELEASE_QUALIFICATIONS,
  V2_NATIVE_RELEASE_INCOMPATIBILITIES,
} from "../src/provider/Layers/OpencodeV2/NativeCompatibility.qualification.registry.ts";
import { validateV2NativeQualificationRegistry } from "../src/provider/Layers/OpencodeV2/NativeCompatibility.qualification.ts";

// Explicit generator/module closure only. Qualification records are deliberately excluded so
// evidence-only additions cannot change native bytes or this generator identity.
const modules = [
  "NativeCompatibility.contract.ts",
  "NativeCompatibility.version.ts",
  "Orchestration.artifact.ts",
  "Orchestration.compatibility.ts",
  "Orchestration.compatibility.legacy.ts",
  "Orchestration.plugin.ts",
  "Orchestration.plugin.identity.ts",
  "Orchestration.plugin.crypto.ts",
  "Orchestration.plugin.registry.ts",
  "Orchestration.plugin.legacy.ts",
  "Orchestration.plugin.specs.ts",
  "Orchestration.protocol.ts",
  "SharedService.capabilities.ts",
  "SharedService.protocol.ts",
  "SharedService.protocol.requests.ts",
  "SharedService.protocol.projections.ts",
  "SharedService.schema.ts",
] as const;
const base = new URL("../src/provider/Layers/OpencodeV2/", import.meta.url);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const closure = await Promise.all(
  [...modules].toSorted().map(async (name) => {
    const source = await readFile(new URL(name, base), "utf8");
    if (source.split("\n").length > 401)
      throw new Error("Native bootstrap generator module exceeds 400 lines.");
    return [name, sha(source)];
  }),
);
const generatorSourceDigest = sha(
  JSON.stringify(["bigbud.thread.native-generator.sources.v1", closure]),
);
const registry = validateV2NativeQualificationRegistry(
  V2_NATIVE_RELEASE_QUALIFICATIONS,
  V2_NATIVE_RELEASE_INCOMPATIBILITIES,
);
for (const { record } of registry.qualified.values())
  if (record.bootstrapGeneratorSourceDigest !== generatorSourceDigest)
    throw new Error(
      "Native qualification bootstrap generator/source identity drift; no record was promoted.",
    );
if (!process.argv.includes("--check"))
  throw new Error(
    "This checker is read-only; use --check. Qualification promotion requires approved native evidence and independent review.",
  );
console.log(
  JSON.stringify({
    qualifiedRecords: registry.qualified.size,
    incompatibleRecords: registry.incompatible.size,
    generatorSourceDigest,
    qualified: registry.qualified.size > 0,
  }),
);
