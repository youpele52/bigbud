import { makeV2SchemaReader, schemaObject, type V2SchemaObject } from "./SharedService.schema.ts";
import { verifyV2ConsumedRequest } from "./SharedService.protocol.requests.ts";

/** Finite request fields the shared application actually supplies. Never admit new mandatory inputs. */
export const V2_SHARED_REQUEST_FIELDS: Record<string, Record<string, string>> = {
  "session.create": {
    id: "string",
    location: "object",
    model: "object",
    metadata: "object",
    permissions: "array",
  },
  "session.update": { permissions: "array" },
  "session.switchModel": { model: "object" },
  "session.prompt": { id: "string", text: "string", files: "array", metadata: "object" },
  "session.permission.reply": { decision: "string" },
  "session.form.reply": { answer: "" },
  "experimental.session.instructions.entry.put": { value: "" },
};

/** Response envelope consumed by the pinned SDK; 204 is intentionally not interchangeable with JSON. */
export const V2_SHARED_RESPONSES: Record<string, string> = {
  "server.info": "info",
  "session.create": "session",
  "session.get": "session",
  "session.list": "page",
  "session.message.list": "page",
  "session.active": "record",
  "session.prompt": "admission",
  "session.interrupt": "interrupt",
  "event.subscribe": "sse",
  "session.permission.get": "interaction",
  "session.form.get": "interaction",
  "agent.list": "array",
  "skill.list": "array",
  "model.list": "array",
  "provider.list": "array",
  "integration.list": "array",
  "mcp.list": "array",
  "session.inbox.list": "array",
  "session.permission.list": "array",
  "session.form.list": "array",
  "permission.saved.list": "array",
  "experimental.session.instructions.entry.list": "array",
};

export function verifyV2ConsumedOperation(
  operation: V2SchemaObject,
  id: string,
  route: string,
  read: ReturnType<typeof makeV2SchemaReader>,
) {
  const expected = V2_SHARED_REQUEST_FIELDS[id];
  verifyV2ConsumedRequest(operation, expected, read);
  const parameters = (operation.parameters ?? []) as unknown[];
  if (!Array.isArray(parameters)) throw new Error("Invalid parameters.");
  for (const match of route.matchAll(/\{([^}]+)\}/g)) {
    const parameter = parameters.find((item) => {
      const p = schemaObject(item);
      return p.name === match[1] && p.in === "path" && p.required === true;
    });
    if (!parameter || read.resolve(schemaObject(parameter).schema).type !== "string")
      throw new Error("Missing path parameter.");
  }
  for (const parameter of parameters) {
    const p = schemaObject(parameter);
    if (p.required === true && p.in !== "path") throw new Error("Unsupported required parameter.");
  }
  if (
    id === "session.interrupt" &&
    !parameters.some((p) => schemaObject(p).name === "resume" && schemaObject(p).in === "query")
  )
    throw new Error("Missing non-resuming interrupt.");
  const responses = schemaObject(operation.responses);
  const kind = V2_SHARED_RESPONSES[id];
  if (!kind) {
    if (!Object.hasOwn(responses, "204")) throw new Error("Missing no-content response.");
    return;
  }
  if (kind === "sse") {
    const response = read.content(responses["200"], "text/event-stream");
    read.field(response, "event", "string");
    read.field(response, "data", "string"); // V2EventEncoded is JSON encoded in an SSE data string.
    const media = schemaObject(
      schemaObject(schemaObject(responses["200"]).content)["text/event-stream"],
    );
    if (schemaObject(media["x-effect-stream"]).encoding !== "sse")
      throw new Error("Incompatible event stream.");
    return;
  }
  const response = read.content(responses["200"]);
  if (kind === "info") {
    read.field(response, "version", "string");
    read.field(response, "pid", "integer");
    return;
  }
  if (kind === "interrupt") {
    read.field(response, "interrupted", "boolean");
    return;
  }
  const data = read.field(
    response,
    "data",
    kind === "array" || kind === "page" ? "array" : "object",
  );
  if (kind === "page") read.field(response, "cursor", "object");
  if (kind === "session") {
    for (const name of ["id", "projectID"]) read.field(data, name, "string");
    read.field(read.field(data, "location", "object"), "directory", "string");
    read.field(data, "metadata", "object");
    read.field(data, "permissions", "array");
    const model = read.field(data, "model", "object");
    read.field(model, "id", "string");
    read.field(model, "providerID", "string");
  }
  if (kind === "admission" || kind === "interaction") {
    read.field(data, "id", "string");
    if (kind === "admission") {
      read.field(data, "sessionID", "string");
      read.field(data, "type", "string");
      read.field(read.field(data, "payload", "object"), "metadata", "object");
    }
  }
  if (id === "model.list" || id === "integration.list") {
    const item = read.resolve(data.items);
    read.field(item, "id", "string");
    if (id === "model.list") {
      read.field(item, "providerID", "string");
      read.field(item, "variants", "array");
    } else read.field(item, "connections", "array");
  }
}
