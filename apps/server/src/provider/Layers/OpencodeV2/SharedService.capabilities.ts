import { Schema } from "effect";
import { V2SharedServiceError } from "./SharedService.errors.ts";
import { makeV2SchemaReader, schemaObject } from "./SharedService.schema.ts";
import { verifyV2ConsumedOperation } from "./SharedService.protocol.ts";

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
  ["delete", "/api/session/{sessionID}/inbox/{inboxID}", "session.inbox.cancel"],
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
  ["get", "/api/session/{sessionID}/permission/{requestID}", "session.permission.get"],
  ["post", "/api/session/{sessionID}/permission/{requestID}/reply", "session.permission.reply"],
  ["get", "/api/session/{sessionID}/form", "session.form.list"],
  ["get", "/api/session/{sessionID}/form/{formID}", "session.form.get"],
  ["post", "/api/session/{sessionID}/form/{formID}/reply", "session.form.reply"],
  ["delete", "/api/session/{sessionID}/form/{formID}", "session.form.cancel"],
  ["get", "/api/event", "event.subscribe"],
] as const;

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

/** Read-only shape checks supplement, never replace, real-runtime qualification. */
export function assertV2SharedCapabilities(
  value: unknown,
  version: string,
  sharedReader?: ReturnType<typeof makeV2SchemaReader>,
): void {
  try {
    const contract = Schema.decodeUnknownSync(Contract)(value);
    if (!contract.openapi.startsWith("3.")) throw new Error("OpenAPI version.");
    const read = sharedReader ?? makeV2SchemaReader(contract.components.schemas);
    for (const [method, route, id] of V2_SHARED_REQUIRED_OPERATIONS) {
      if (!contract.paths[route]?.[method])
        throw new V2SharedServiceError(
          "compatibility",
          `OpenCode v2 ${version} is missing the required ${id} capability. Use a compatible V2 runtime; no native work was submitted.`,
          version,
        );
      const operation = Schema.decodeUnknownSync(Operation)(contract.paths[route]?.[method]);
      try {
        verifyV2ConsumedOperation(schemaObject(contract.paths[route]?.[method]), id, route, read);
      } catch {
        throw new V2SharedServiceError(
          "compatibility",
          `OpenCode v2 ${version} has an incompatible ${id} protocol contract; no native work was submitted.`,
          version,
        );
      }
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
          `OpenCode v2 ${version} does not expose the required ${id} contract. Use a compatible V2 runtime; no native work was submitted.`,
          version,
        );
    }
  } catch (error) {
    if (error instanceof V2SharedServiceError) throw error;
    throw new V2SharedServiceError(
      "compatibility",
      `OpenCode v2 ${version} has an invalid or incomplete API contract. Check the native service or use a compatible V2 runtime; no native work was submitted.`,
      version,
    );
  }
}
