import { makeV2SchemaReader, schemaObject, type V2SchemaObject } from "./SharedService.schema.ts";

function requiredFields(shape: V2SchemaObject, supported: readonly string[]) {
  if (shape.required === undefined) return;
  if (
    !Array.isArray(shape.required) ||
    shape.required.some((name) => typeof name !== "string" || !supported.includes(name))
  )
    throw new Error("Unsupported required request field.");
}

function accepts(shape: V2SchemaObject, values: readonly string[]) {
  const enumeration = shape.enum;
  if (
    enumeration !== undefined &&
    (!Array.isArray(enumeration) || values.some((value) => !enumeration.includes(value)))
  )
    throw new Error("Unsupported request enum.");
}

/** Only the nested objects emitted by owned-session creation, policy and admission are interpreted. */
export function verifyV2ConsumedRequest(
  operation: V2SchemaObject,
  expected: Record<string, string> | undefined,
  read: ReturnType<typeof makeV2SchemaReader>,
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
  if (expected.permissions) {
    const rule = read.resolve(read.field(body, "permissions", "array").items);
    for (const field of ["action", "resource", "effect"]) read.field(rule, field, "string");
    requiredFields(rule, ["action", "resource", "effect"]);
    accepts(read.field(rule, "effect"), ["allow", "ask", "deny"]);
  }
  if (expected.decision)
    accepts(read.field(body, "decision", "string"), ["once", "always", "reject"]);
}
