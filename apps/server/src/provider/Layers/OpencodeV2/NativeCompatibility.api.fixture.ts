import { readFileSync } from "node:fs";
import { v2OfficialContract } from "./SharedService.official.fixture.ts";

/** Independent static official projections; simulated versions never constitute native qualification. */
export function v2CanonicalApiFixture() {
  const base = v2OfficialContract("2.0.26");
  for (const line of readFileSync(
    new URL("./NativeCompatibility.official.ndjson", import.meta.url),
    "utf8",
  )
    .trim()
    .split("\n")) {
    const record = JSON.parse(line);
    if (record.kind === "path")
      base.paths[record.name] = { ...base.paths[record.name], ...record.value };
    else if (record.kind === "schema") base.components.schemas[record.name] = record.value;
    else if (record.kind !== "provenance") throw new Error("Unknown official fixture record.");
  }
  return base;
}
