import { Schema } from "effect";
import { V2SharedServiceError } from "./SharedService.errors.ts";

/** Every route used by foreground ownership, durable admission, projection and discovery. */
export const V2_SHARED_REQUIRED_OPERATIONS = [
  ["get", "/api/info", "server.info"],
  ["get", "/api/agent", "agent.list"],
  ["get", "/api/skill", "skill.list"],
  ["get", "/api/model", "model.list"],
  ["get", "/api/provider", "provider.list"],
  ["get", "/api/integration", "integration.list"],
  ["get", "/api/mcp", "mcp.list"],
  ["get", "/api/session", "session.list"],
  ["post", "/api/session", "session.create"],
  ["get", "/api/session/active", "session.active"],
  ["get", "/api/session/{sessionID}", "session.get"],
  ["patch", "/api/session/{sessionID}", "session.update"],
  ["post", "/api/session/{sessionID}/model", "session.switchModel"],
  ["post", "/api/session/{sessionID}/prompt", "session.prompt"],
  ["post", "/api/session/{sessionID}/interrupt", "session.interrupt"],
  ["get", "/api/session/{sessionID}/message", "session.message.list"],
  ["get", "/api/session/{sessionID}/inbox", "session.inbox.list"],
  [
    "get",
    "/api/experimental/session/{sessionID}/instructions/entries",
    "experimental.session.instructions.entry.list",
  ],
  [
    "put",
    "/api/experimental/session/{sessionID}/instructions/entries/{key}",
    "experimental.session.instructions.entry.put",
  ],
  [
    "delete",
    "/api/experimental/session/{sessionID}/instructions/entries/{key}",
    "experimental.session.instructions.entry.remove",
  ],
  ["get", "/api/permission/saved", "permission.saved.list"],
  ["get", "/api/session/{sessionID}/permission", "session.permission.list"],
  ["post", "/api/session/{sessionID}/permission/{requestID}/reply", "session.permission.reply"],
  ["get", "/api/session/{sessionID}/form", "session.form.list"],
  ["post", "/api/session/{sessionID}/form/{formID}/reply", "session.form.reply"],
  ["delete", "/api/session/{sessionID}/form/{formID}", "session.form.cancel"],
  ["get", "/api/event", "event.subscribe"],
] as const;

const Shape = Schema.Struct({
  type: Schema.optional(Schema.String),
  properties: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  required: Schema.optional(Schema.Array(Schema.String)),
});
const Contract = Schema.Struct({
  openapi: Schema.String,
  paths: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
  components: Schema.Struct({ schemas: Schema.Record(Schema.String, Schema.Unknown) }),
});
const Operation = Schema.Struct({
  operationId: Schema.String,
  responses: Schema.Record(Schema.String, Schema.Unknown),
  requestBody: Schema.optional(Schema.Unknown),
});
const Field = Schema.Struct({
  type: Schema.optional(Schema.String),
  $ref: Schema.optional(Schema.String),
});
const requiredShapes = {
  ServerInfo: ["version", "pid"],
  "Session.Info": ["id", "location", "metadata", "permissions", "model", "projectID"],
  "Model.Info": ["id", "providerID", "variants"],
  "Integration.Info": ["id", "connections"],
} as const;
const fieldContracts = [
  ["ServerInfo", "version", "type", "string"],
  ["ServerInfo", "pid", "type", "integer"],
  ["Session.Info", "id", "type", "string"],
  ["Session.Info", "projectID", "type", "string"],
  ["Session.Info", "location", "$ref", "#/components/schemas/Location.PublicRef"],
  ["Session.Info", "metadata", "$ref", "#/components/schemas/Session.Metadata"],
  ["Session.Info", "permissions", "$ref", "#/components/schemas/Permission.Ruleset"],
  ["Session.Info", "model", "$ref", "#/components/schemas/Model.Ref"],
  ["Model.Info", "id", "type", "string"],
  ["Model.Info", "providerID", "type", "string"],
  ["Model.Info", "variants", "type", "array"],
  ["Integration.Info", "connections", "type", "array"],
] as const;

/** Read-only shape checks supplement, never replace, real-runtime qualification. */
export function assertV2SharedCapabilities(value: unknown, version: string): void {
  try {
    const contract = Schema.decodeUnknownSync(Contract)(value);
    if (!contract.openapi.startsWith("3.")) throw new Error("OpenAPI version.");
    for (const [method, route, id] of V2_SHARED_REQUIRED_OPERATIONS) {
      if (!contract.paths[route]?.[method])
        throw new V2SharedServiceError(
          "compatibility",
          `OpenCode v2 ${version} is missing the required ${id} capability. Use a qualified runtime; no native work was submitted.`,
          version,
        );
      const operation = Schema.decodeUnknownSync(Operation)(contract.paths[route]?.[method]);
      if (
        operation.operationId !== id ||
        !(Object.hasOwn(operation.responses, "200") || Object.hasOwn(operation.responses, "204")) ||
        (method !== "get" &&
          method !== "delete" &&
          id !== "session.interrupt" &&
          !operation.requestBody)
      )
        throw new V2SharedServiceError(
          "compatibility",
          `OpenCode v2 ${version} does not expose the required ${id} contract. Update to a qualified runtime; no native work was submitted.`,
          version,
        );
    }
    for (const [name, fields] of Object.entries(requiredShapes)) {
      const shape = Schema.decodeUnknownSync(Shape)(contract.components.schemas[name]);
      if (
        shape.type !== "object" ||
        fields.some((field) => !Object.hasOwn(shape.properties ?? {}, field))
      )
        throw new V2SharedServiceError(
          "compatibility",
          `OpenCode v2 ${version} does not expose the required ${name} shape. Update to a qualified runtime; no native work was submitted.`,
          version,
        );
    }
    for (const [name, field, kind, expected] of fieldContracts) {
      const shape = Schema.decodeUnknownSync(Shape)(contract.components.schemas[name]);
      const property = Schema.decodeUnknownSync(Field)(shape.properties?.[field]);
      if (property[kind] !== expected)
        throw new V2SharedServiceError(
          "compatibility",
          `OpenCode v2 ${version} has an incompatible ${name}.${field} contract. Use a qualified runtime; no native work was submitted.`,
          version,
        );
      if (kind === "$ref") {
        const target = expected.slice("#/components/schemas/".length);
        if (!Object.hasOwn(contract.components.schemas, target))
          throw new Error("Missing referenced contract.");
      }
    }
  } catch (error) {
    if (error instanceof V2SharedServiceError) throw error;
    throw new V2SharedServiceError(
      "compatibility",
      `OpenCode v2 ${version} has an invalid or incomplete API contract. Check the native service or use a qualified runtime; no native work was submitted.`,
      version,
    );
  }
}
