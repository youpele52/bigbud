import {
  acceptsV2Values,
  makeV2SchemaReader,
  schemaObject,
  type V2SchemaObject,
} from "./SharedService.schema.ts";

function requiredFields(shape: V2SchemaObject, supported: readonly string[]) {
  if (shape.required === undefined) return;
  if (
    !Array.isArray(shape.required) ||
    shape.required.some((name) => typeof name !== "string" || !supported.includes(name))
  )
    throw new Error("Unsupported required request field.");
}

/** Only the nested objects emitted by owned-session creation, policy and admission are interpreted. */
export function verifyV2ConsumedRequest(
  operation: V2SchemaObject,
  expected: Record<string, string> | undefined,
  read: ReturnType<typeof makeV2SchemaReader>["input"],
) {
  if (!expected) {
    if (operation.requestBody && schemaObject(operation.requestBody).required === true)
      throw new Error("Unexpected required request body.");
    return;
  }
  const body = read.content(operation.requestBody);
  if (body.type !== "object") throw new Error("Request object missing.");
  for (const [name, type] of Object.entries(expected)) read.field(body, name, type || undefined);
  requiredFields(body, Object.keys(expected));
  if (expected.model) {
    const model = read.field(body, "model", "object");
    for (const field of ["id", "providerID", "variant"]) read.field(model, field, "string");
    requiredFields(model, ["id", "providerID"]);
  }
  if (expected.location) {
    const location = read.field(body, "location", "object");
    read.field(location, "directory", "string");
    requiredFields(location, ["directory"]);
  }
  if (expected.metadata) requiredFields(read.field(body, "metadata", "object"), []);
  if (expected.files) {
    const attachment = read.resolve(read.field(body, "files", "array").items);
    read.field(attachment, "uri", "string");
    read.field(attachment, "name", "string");
    requiredFields(attachment, ["uri", "name"]);
  }
  if (expected.delivery) acceptsV2Values(read.field(body, "delivery", "string"), ["queue"]);
  if (expected.resume) acceptsV2Values(read.field(body, "resume", "boolean"), [true]);
  if (expected.permissions) {
    const rule = read.resolve(read.field(body, "permissions", "array").items);
    for (const field of ["action", "resource", "effect"]) read.field(rule, field, "string");
    requiredFields(rule, ["action", "resource", "effect"]);
    acceptsV2Values(read.field(rule, "effect"), ["allow", "ask", "deny"]);
  }
  if (expected.decision)
    acceptsV2Values(read.field(body, "decision", "string"), ["once", "always", "reject"]);
}
