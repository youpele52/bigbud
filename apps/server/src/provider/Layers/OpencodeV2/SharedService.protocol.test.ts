import { expect, it } from "vitest";
import { assertV2SharedCapabilities } from "./SharedService.capabilities.ts";
import { v2OfficialContract } from "./SharedService.official.fixture.ts";
import { makeV2SchemaReader, schemaObject } from "./SharedService.schema.ts";

it.each(["2.0.24", "2.0.26"] as const)(
  "accepts the independent pinned official %s contract",
  (version) => {
    expect(() => assertV2SharedCapabilities(v2OfficialContract(version), version)).not.toThrow();
  },
);

// Mutate actual upstream structures, not a test document derived from the checker manifest.
it.each([
  "prompt-delivery",
  "prompt-resume",
  "ack-delivery",
  "ack-type",
  "ack-wrapper",
  "attachment-uri",
  "attachment-required",
  "attachment-name",
  "message-items",
  "inbox-items",
  "inbox-metadata",
  "message-user-metadata",
  "assistant-completed",
  "assistant-content",
  "assistant-text",
  "assistant-reasoning",
  "assistant-tool-id",
  "tool-status",
  "tool-error",
  "tool-text",
  "token-cache",
  "idle-outcome",
  "cursor-next",
  "cursor-query",
  "order-query",
  "interrupt-resume",
  "optional-wrapper",
  "optional-content",
  "wrong-wrapper-type",
  "assistant-model",
  "assistant-error-type",
  "assistant-error-status",
  "limit-query",
  "directory-query",
  "optional-cursor",
])("rejects consumed protocol regression: %s", (scenario) => {
  const contract = v2OfficialContract();
  const schemas = contract.components.schemas;
  const read = makeV2SchemaReader(schemas);
  const operation = (path: string, method = "get") => schemaObject(contract.paths[path]![method]);
  const prompt = operation("/api/session/{sessionID}/prompt", "post");
  const body = read.content(prompt.requestBody);
  const response = read.content(schemaObject(prompt.responses)["200"]);
  const property = (name: string, key: string) => schemaObject(schemas[name]!.properties[key]);
  const corrupt = (name: string, key: string) => {
    schemas[name]!.properties[key] = { type: "boolean" };
  };
  if (scenario === "prompt-delivery")
    schemaObject(body.properties).delivery = { type: "string", enum: ["steer"] };
  if (scenario === "prompt-resume")
    schemaObject(body.properties).resume = { type: "boolean", enum: [false] };
  if (scenario === "ack-delivery") schemas["Session.Inbox.Delivery"]!.enum = ["steer"];
  if (scenario === "ack-type") property("Session.Inbox.User", "type").enum = ["synthetic"];
  if (scenario === "ack-wrapper") schemaObject(response.properties).data = { type: "array" };
  if (scenario === "attachment-uri") corrupt("PromptInput.FileAttachment", "uri");
  if (scenario === "attachment-name") corrupt("PromptInput.FileAttachment", "name");
  if (scenario === "attachment-required")
    schemas["PromptInput.FileAttachment"]!.required = ["uri", "mention"];
  if (scenario === "message-items")
    property("SessionMessagesResponse", "data").items = { type: "object", properties: {} };
  if (scenario === "inbox-items") schemas["Session.Inbox.Info"]!.anyOf = [];
  if (scenario === "inbox-metadata") corrupt("Session.Inbox.UserPayload", "metadata");
  if (scenario === "message-user-metadata") corrupt("Session.Message.User", "metadata");
  if (scenario === "assistant-completed")
    schemaObject(property("Session.Message.Assistant", "time").properties).completed = {
      type: "string",
    };
  if (scenario === "assistant-content") corrupt("Session.Message.Assistant", "content");
  if (scenario === "assistant-text") corrupt("Session.Message.Assistant.Text", "text");
  if (scenario === "assistant-reasoning") corrupt("Session.Message.Assistant.Reasoning", "text");
  if (scenario === "assistant-tool-id") corrupt("Session.Message.Assistant.Tool", "id");
  if (scenario === "tool-status")
    property("Session.Message.ToolState.Completed", "status").enum = ["done"];
  if (scenario === "tool-error") corrupt("Session.StructuredError", "message");
  if (scenario === "tool-text") corrupt("Tool.TextContent", "text");
  if (scenario === "token-cache") corrupt("TokenUsage.Info", "cache");
  if (scenario === "idle-outcome") property("Session.Message.Idle", "outcome").enum = ["succeeded"];
  if (scenario === "cursor-next")
    schemaObject(property("SessionMessagesResponse", "cursor").properties).next = {
      type: "number",
    };
  if (
    scenario === "cursor-query" ||
    scenario === "order-query" ||
    scenario === "interrupt-resume"
  ) {
    const interrupt = scenario === "interrupt-resume";
    const op = operation(
      `/api/session/{sessionID}/${interrupt ? "interrupt" : "message"}`,
      interrupt ? "post" : "get",
    );
    const name = interrupt ? "resume" : scenario === "cursor-query" ? "cursor" : "order";
    const parameter = (op.parameters as unknown[]).map(schemaObject).find((p) => p.name === name)!;
    parameter.schema = { type: "string", enum: [interrupt ? "true" : "desc"] };
    if (name === "cursor") parameter.schema = { type: "number" };
  }
  if (scenario === "optional-wrapper") response.required = [];
  if (scenario === "optional-content")
    schemas["Session.Message.Assistant"]!.required = ["id", "time", "type", "agent", "model"];
  if (scenario === "wrong-wrapper-type") response.type = "array";
  if (scenario === "assistant-model") corrupt("Session.Message.Assistant", "model");
  if (scenario === "assistant-error-type") corrupt("Session.StructuredError", "type");
  if (scenario === "assistant-error-status") corrupt("Session.StructuredError", "status");
  if (scenario === "limit-query" || scenario === "directory-query") {
    const parameter = (operation("/api/session").parameters as unknown[])
      .map(schemaObject)
      .find((p) => p.name === (scenario === "limit-query" ? "limit" : "directory"))!;
    parameter.schema =
      scenario === "limit-query" ? { type: "string", enum: ["1"] } : { type: "number" };
  }
  if (scenario === "optional-cursor") schemas["SessionsResponse"]!.required = ["data"];
  expect(() => assertV2SharedCapabilities(contract, "2.1.0")).toThrow("incompatible");
});

it("accepts equivalent renamed/inlined projections and additive fields/values", () => {
  const contract = v2OfficialContract();
  contract.components.schemas["Session.Inbox.Delivery"]!.enum = ["queue", "steer", "future"];
  contract.components.schemas["Session.Message.Assistant"]!.properties.future = { type: "string" };
  let encoded = JSON.stringify(contract).replaceAll("Session.Message.User", "RenamedUser");
  const renamed = JSON.parse(encoded);
  encoded = encoded.replaceAll(
    JSON.stringify({ $ref: "#/components/schemas/RenamedUser" }),
    JSON.stringify(renamed.components.schemas.RenamedUser),
  );
  expect(() => assertV2SharedCapabilities(JSON.parse(encoded), "2.2.0")).not.toThrow();
});
