import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { V2_CANONICAL_NATIVE_OPERATIONS } from "../src/provider/Layers/OpencodeV2/NativeCompatibility.contract.ts";

const input = process.argv[2];
if (!input)
  throw new Error(
    "Supply the saved official pinned 2.0.28 OpenAPI JSON; no native service or network is read.",
  );
const source = await readFile(input, "utf8");
if (
  createHash("sha256").update(source).digest("hex") !==
  "7ec8b0a3ccf4b5161be5b49947e306f02cb04662048d796bd03bce905a84f109"
)
  throw new Error(
    "Official pinned API fixture bytes changed; review provenance before regeneration.",
  );
const api = JSON.parse(source),
  schemas = new Set<string>();
function visit(value: unknown) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(visit);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === "string") {
    const prefix = "#/components/schemas/";
    if (!record.$ref.startsWith(prefix)) throw new Error("External official fixture reference.");
    const name = record.$ref.slice(prefix.length).replaceAll("~1", "/").replaceAll("~0", "~");
    if (!schemas.has(name)) {
      if (schemas.size >= 390 || !api.components.schemas[name])
        throw new Error("Official fixture closure bound.");
      schemas.add(name);
      visit(api.components.schemas[name]);
    }
  }
  Object.values(record).forEach(visit);
}
const records: unknown[] = [
  {
    kind: "provenance",
    version: "2.0.28",
    openapi: api.openapi,
    sourceCommit: "026b106bc5d41b679ffc413264229c340871e4d3",
    sha256: createHash("sha256").update(source).digest("hex"),
  },
];
for (const [method, route] of V2_CANONICAL_NATIVE_OPERATIONS) {
  const value = { [method]: api.paths[route][method] };
  visit(value);
  records.push({ kind: "path", name: route, value });
}
for (const name of [...schemas].toSorted())
  records.push({ kind: "schema", name, value: api.components.schemas[name] });
if (records.length > 400) throw new Error("Generated fixture exceeds 400 lines.");
const output = new URL(
  "../src/provider/Layers/OpencodeV2/NativeCompatibility.official.ndjson",
  import.meta.url,
);
const generated = `${records.map((v) => JSON.stringify(v)).join("\n")}\n`;
if (process.argv.includes("--check")) {
  if ((await readFile(output, "utf8")) !== generated)
    throw new Error("Official native API fixture drift.");
} else await writeFile(output, generated);
