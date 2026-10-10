import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { V2_SHARED_REQUIRED_OPERATIONS } from "./SharedService.capabilities.ts";

/** Synthetic contract seam; native qualification uses the actual runtime OpenAPI. */
export function sharedServiceTestContract() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [method, route, operationId] of V2_SHARED_REQUIRED_OPERATIONS) {
    (paths[route] ??= {})[method] = { operationId, responses: { "200": {} }, requestBody: {} };
  }
  const shapes = {
    ServerInfo: ["version", "pid"],
    "Session.Info": ["id", "location", "metadata", "permissions", "model", "projectID"],
    "Model.Info": ["id", "providerID", "variants"],
    "Integration.Info": ["id", "connections"],
  };
  const contract = {
    openapi: "3.1.0",
    paths,
    components: {
      schemas: Object.fromEntries(
        Object.entries(shapes).map(([name, fields]) => [
          name,
          { type: "object", properties: Object.fromEntries(fields.map((field) => [field, {}])) },
        ]),
      ),
    },
  };
  const schemas = contract.components.schemas;
  schemas.ServerInfo!.properties = { version: { type: "string" }, pid: { type: "integer" } };
  schemas["Session.Info"]!.properties = {
    id: { type: "string" },
    projectID: { type: "string" },
    location: { $ref: "#/components/schemas/Location.PublicRef" },
    metadata: { $ref: "#/components/schemas/Session.Metadata" },
    permissions: { $ref: "#/components/schemas/Permission.Ruleset" },
    model: { $ref: "#/components/schemas/Model.Ref" },
  };
  schemas["Model.Info"]!.properties = {
    id: { type: "string" },
    providerID: { type: "string" },
    variants: { type: "array" },
  };
  schemas["Integration.Info"]!.properties = {
    id: { type: "string" },
    connections: { type: "array" },
  };
  for (const name of ["Location.PublicRef", "Session.Metadata", "Permission.Ruleset", "Model.Ref"])
    schemas[name] = { type: "object", properties: {} };
  return contract;
}

/** Private disposable native-registration shape; never edits a real service file. */
export async function sharedServiceTestRegistration(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2-shared-unit-"));
  const file = path.join(root, "service.json");
  const value = {
    id: "fixture-instance",
    version: "2.0.24",
    url: "http://127.0.0.1:4096",
    pid: 42,
    password: "private-fixture-password",
    ...overrides,
  };
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  return { file, root, value, close: () => rm(root, { recursive: true, force: true }) };
}
