import { schemaObject, type makeV2SchemaReader } from "./SharedService.schema.ts";

function onlyValues(shape: Record<string, unknown>, allowed: readonly string[]) {
  const values = shape.enum ?? (shape.const === undefined ? undefined : [shape.const]);
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.some((value) => !allowed.includes(value as string))
  )
    throw new Error("Unknown consumed native security/terminal variant.");
}

/** Canonical admission cannot trust new terminal/tool states merely because discovery can still list models. */
export function verifyV2NativeSecurityProjections(
  paths: Record<string, unknown>,
  read: ReturnType<typeof makeV2SchemaReader>,
) {
  const operation = schemaObject(schemaObject(paths["/api/session/{sessionID}/message"]).get);
  const response = read.content(schemaObject(operation.responses)["200"]);
  const messages = read.requiredField(response, "data", "array").items;
  for (const variant of read.variants(messages))
    onlyValues(read.requiredField(variant, "type", "string"), [
      "agent-switched",
      "model-switched",
      "location-switched",
      "user",
      "synthetic",
      "system",
      "shell",
      "skill",
      "assistant",
      "compaction",
      "idle",
    ]);
  onlyValues(read.requiredField(read.tagged(messages, "type", "idle"), "outcome", "string"), [
    "succeeded",
    "failed",
    "interrupted",
  ]);
  const assistant = read.tagged(messages, "type", "assistant"),
    tool = read.tagged(read.requiredField(assistant, "content", "array").items, "type", "tool");
  const states = read.requiredField(tool, "state");
  for (const variant of read.variants(states))
    onlyValues(read.requiredField(variant, "status", "string"), [
      "streaming",
      "running",
      "completed",
      "error",
    ]);
}
