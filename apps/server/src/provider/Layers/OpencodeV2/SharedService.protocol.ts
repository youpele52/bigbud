import {
  acceptsV2Values,
  makeV2SchemaReader,
  schemaObject,
  type V2SchemaObject,
} from "./SharedService.schema.ts";
import { verifyV2ConsumedRequest } from "./SharedService.protocol.requests.ts";
import {
  verifyV2InboxUser,
  verifyV2MessageProjection,
  verifyV2SessionProjection,
} from "./SharedService.protocol.projections.ts";

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
  "session.prompt": {
    id: "string",
    text: "string",
    files: "array",
    metadata: "object",
    delivery: "string",
    resume: "boolean",
  },
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
  verifyV2ConsumedRequest(operation, expected, read.input);
  const parameters = (operation.parameters ?? []) as unknown[];
  if (!Array.isArray(parameters)) throw new Error("Invalid parameters.");
  for (const match of route.matchAll(/\{([^}]+)\}/g)) {
    const parameter = parameters.find((item) => {
      const p = schemaObject(item);
      return p.name === match[1] && p.in === "path" && p.required === true;
    });
    if (!parameter || read.input.resolve(schemaObject(parameter).schema).type !== "string")
      throw new Error("Missing path parameter.");
  }
  for (const parameter of parameters) {
    const p = schemaObject(parameter);
    if (p.required === true && p.in !== "path") throw new Error("Unsupported required parameter.");
  }
  const query = (name: string) => {
    const parameter = parameters.find(
      (p) => schemaObject(p).name === name && schemaObject(p).in === "query",
    );
    const shape = read.input.resolve(schemaObject(parameter).schema);
    if (shape.type !== "string") throw new Error("Incompatible query parameter.");
    return shape;
  };
  if (id === "session.interrupt") acceptsV2Values(query("resume"), ["false"]);
  if (id === "session.list" || id === "session.message.list") {
    acceptsV2Values(query("limit"), id === "session.list" ? ["200"] : ["100", "1"]);
    query("cursor");
    if (id === "session.message.list") acceptsV2Values(query("order"), ["asc"]);
    else query("directory");
  }
  const responses = schemaObject(operation.responses);
  const kind = V2_SHARED_RESPONSES[id];
  if (!kind) {
    if (!Object.hasOwn(responses, "204")) throw new Error("Missing no-content response.");
    return;
  }
  if (kind === "sse") {
    const response = read.content(responses["200"], "text/event-stream");
    read.requiredField(response, "event", "string");
    read.requiredField(response, "data", "string"); // V2EventEncoded is JSON encoded in an SSE data string.
    const media = schemaObject(
      schemaObject(schemaObject(responses["200"]).content)["text/event-stream"],
    );
    if (schemaObject(media["x-effect-stream"]).encoding !== "sse")
      throw new Error("Incompatible event stream.");
    return;
  }
  const response = read.content(responses["200"]);
  if (kind === "info") {
    read.requiredField(response, "version", "string");
    read.requiredField(response, "pid", "integer");
    return;
  }
  if (kind === "interrupt") {
    read.requiredField(response, "interrupted", "boolean");
    return;
  }
  const data = read.requiredField(
    response,
    "data",
    kind === "array" || kind === "page" ? "array" : "object",
  );
  if (kind === "page")
    read.nullableField(read.requiredField(response, "cursor", "object"), "next", "string");
  if (kind === "session") verifyV2SessionProjection(data, read);
  if (id === "session.list") verifyV2SessionProjection(read.resolve(data.items), read);
  if (id === "session.message.list") verifyV2MessageProjection(data.items, read);
  if (id === "session.inbox.list") verifyV2InboxUser(read.tagged(data.items, "type", "user"), read);
  if (kind === "admission" || kind === "interaction") {
    read.field(data, "id", "string");
    if (kind === "admission") verifyV2InboxUser(data, read);
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
