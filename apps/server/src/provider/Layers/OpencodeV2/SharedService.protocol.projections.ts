import {
  acceptsV2Values,
  makeV2SchemaReader,
  type V2SchemaObject,
} from "./SharedService.schema.ts";

type Reader = ReturnType<typeof makeV2SchemaReader>;

/** The admission reconciler consumes the user variant, never a generic arbitrary inbox object. */
export function verifyV2InboxUser(user: V2SchemaObject, read: Reader) {
  for (const key of ["id", "sessionID", "type", "delivery"])
    read.requiredField(user, key, "string");
  acceptsV2Values(read.field(user, "type"), ["user"]);
  acceptsV2Values(read.field(user, "delivery"), ["queue"]);
  read.field(read.requiredField(user, "payload", "object"), "metadata", "object");
}

export function verifyV2SessionProjection(session: V2SchemaObject, read: Reader) {
  for (const key of ["id", "projectID"]) read.field(session, key, "string");
  read.field(read.field(session, "location", "object"), "directory", "string");
  read.field(session, "metadata", "object");
  const rules = read.resolve(read.field(session, "permissions", "array").items);
  for (const key of ["action", "resource", "effect"]) read.field(rules, key, "string");
  acceptsV2Values(read.field(rules, "effect"), ["allow", "ask", "deny"]);
  const model = read.field(session, "model", "object");
  for (const key of ["id", "providerID", "variant"]) read.field(model, key, "string");
}

/** Finite projection paths used for correlation, terminal state, text/tools and token accounting. */
export function verifyV2MessageProjection(items: unknown, read: Reader) {
  for (const tag of ["user", "synthetic", "shell", "skill", "assistant", "idle"]) {
    const message = read.tagged(items, "type", tag);
    read.requiredField(message, "id", "string");
    read.requiredField(read.requiredField(message, "time", "object"), "created", "number");
    if (tag === "user") read.field(message, "metadata", "object");
    if (tag === "idle")
      acceptsV2Values(read.requiredField(message, "outcome", "string"), [
        "succeeded",
        "failed",
        "interrupted",
      ]);
    if (tag !== "assistant") continue;
    read.field(read.field(message, "time", "object"), "completed", "number");
    acceptsV2Values(read.field(message, "finish", "string"), [
      "stop",
      "length",
      "tool-calls",
      "content-filter",
      "error",
      "unknown",
    ]);
    const error = read.field(message, "error", "object");
    for (const key of ["message", "type"]) read.requiredField(error, key, "string");
    read.field(error, "status", "integer");
    const model = read.requiredField(message, "model", "object");
    for (const key of ["id", "providerID"]) read.requiredField(model, key, "string");
    read.field(message, "retry", "object");
    const tokens = read.field(message, "tokens", "object");
    for (const key of ["input", "output", "reasoning"]) read.requiredField(tokens, key, "number");
    for (const key of ["read", "write"])
      read.requiredField(read.requiredField(tokens, "cache", "object"), key, "number");
    const content = read.requiredField(message, "content", "array");
    for (const tag of ["text", "reasoning"])
      read.requiredField(read.tagged(content.items, "type", tag), "text", "string");
    const tool = read.tagged(content.items, "type", "tool");
    for (const key of ["id", "name"]) read.requiredField(tool, key, "string");
    const state = read.requiredField(tool, "state");
    for (const status of ["streaming", "running", "completed", "error"]) {
      const variant = read.tagged(state, "status", status);
      if (status === "error")
        read.requiredField(read.requiredField(variant, "error", "object"), "message", "string");
      if (status === "completed") {
        const content = read.requiredField(variant, "content", "array");
        for (const item of [content.items, ...((content.prefixItems ?? []) as unknown[])])
          read.requiredField(read.tagged(item, "type", "text"), "text", "string");
      }
    }
  }
}
