import { readFileSync } from "node:fs";

export interface V2OfficialFixture {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, { properties: Record<string, unknown>; [key: string]: unknown }>;
  };
}

/** Load a fresh independent pinned upstream endpoint/ref closure; no production manifest is imported. */
export function v2OfficialContract(version: "2.0.24" | "2.0.26" = "2.0.24"): V2OfficialFixture {
  const lines = readFileSync(new URL("./SharedService.official.ndjson", import.meta.url), "utf8")
    .trim()
    .split("\n");
  const result: V2OfficialFixture = { openapi: "", paths: {}, components: { schemas: {} } };
  for (const line of lines) {
    const record = JSON.parse(line);
    if (record.kind === "provenance") {
      if (record.version === version) result.openapi = record.openapi;
    } else if (record.kind === "path") result.paths[record.name] = record.value;
    else if (record.kind === "schema") result.components.schemas[record.name] = record.value;
    else throw new Error("Unexpected official fixture record.");
  }
  if (!result.openapi) throw new Error("Official fixture version missing.");
  return result;
}
