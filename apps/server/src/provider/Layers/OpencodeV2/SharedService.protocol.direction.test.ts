import { expect, it } from "vitest";
import { assertV2SharedCapabilities } from "./SharedService.capabilities.ts";
import { v2OfficialContract } from "./SharedService.official.fixture.ts";
import { makeV2SchemaReader, schemaObject } from "./SharedService.schema.ts";

const nullableSites = [
  "messages-data",
  "prompt-data",
  "messages-envelope",
  "message-items",
  "message-created",
  "assistant-content",
  "tool-state",
  "token-cache",
  "session-cursor",
  "cursor-next-alternative",
] as const;

for (const union of ["anyOf", "oneOf"] as const) {
  it.each(nullableSites)(
    `rejects nullable response %s through ${union}, including referenced null`,
    (site) => {
      const contract = v2OfficialContract();
      const schemas = contract.components.schemas;
      const read = makeV2SchemaReader(schemas);
      // A referenced null must not disappear while resolving a nested union or tagged item.
      schemas.NullableBranch = { type: "null", properties: {} };
      const nullable = (value: unknown) => ({
        [union]: [{ [union]: [value] }, { $ref: "#/components/schemas/NullableBranch" }],
      });
      const property = (name: string, key: string) => schemaObject(schemas[name]!.properties[key]);
      const wrap = (properties: Record<string, unknown>, key: string) => {
        properties[key] = nullable(properties[key]);
      };
      if (site === "messages-data") wrap(schemas.SessionMessagesResponse!.properties, "data");
      if (site === "prompt-data") {
        const prompt = schemaObject(contract.paths["/api/session/{sessionID}/prompt"]!.post);
        wrap(schemaObject(read.content(schemaObject(prompt.responses)["200"]).properties), "data");
      }
      if (site === "messages-envelope")
        Object.assign(
          schemas.SessionMessagesResponse!,
          nullable(structuredClone(schemas.SessionMessagesResponse!)),
          { type: undefined, properties: undefined },
        );
      if (site === "message-items") wrap(property("SessionMessagesResponse", "data"), "items");
      if (site === "message-created")
        wrap(schemaObject(property("Session.Message.User", "time").properties), "created");
      if (site === "assistant-content")
        wrap(schemas["Session.Message.Assistant"]!.properties, "content");
      if (site === "tool-state")
        wrap(schemas["Session.Message.Assistant.Tool"]!.properties, "state");
      if (site === "token-cache") wrap(schemas["TokenUsage.Info"]!.properties, "cache");
      if (site === "session-cursor") wrap(schemas.SessionsResponse!.properties, "cursor");
      if (site === "cursor-next-alternative") {
        const properties = schemaObject(property("SessionMessagesResponse", "cursor").properties);
        properties.next = { [union]: [properties.next, { type: "number" }] };
      }
      expect(() => assertV2SharedCapabilities(contract, "2.1.0")).toThrow("incompatible");
    },
  );
}

it.each(["messages", "prompt"])(
  "rejects direct nullable %s data from the official fixture",
  (site) => {
    const contract = v2OfficialContract();
    const read = makeV2SchemaReader(contract.components.schemas);
    const prompt = schemaObject(contract.paths["/api/session/{sessionID}/prompt"]!.post);
    const properties =
      site === "messages"
        ? contract.components.schemas.SessionMessagesResponse!.properties
        : schemaObject(read.content(schemaObject(prompt.responses)["200"]).properties);
    properties.data = { anyOf: [properties.data, { type: "null" }] };
    expect(() => assertV2SharedCapabilities(contract, "2.1.0")).toThrow("incompatible");
  },
);

it("accepts nullable request fields/body and the genuinely nullable response cursor.next", () => {
  const contract = v2OfficialContract();
  const read = makeV2SchemaReader(contract.components.schemas);
  const prompt = schemaObject(contract.paths["/api/session/{sessionID}/prompt"]!.post);
  const body = read.input.content(prompt.requestBody);
  const properties = schemaObject(body.properties);
  // Official id/delivery/resume and create model/location already include nullable inputs.
  for (const key of ["text", "files", "metadata"])
    properties[key] = { anyOf: [properties[key], { type: "null" }] };
  const content = schemaObject(schemaObject(prompt.requestBody).content);
  schemaObject(content["application/json"]).schema = { anyOf: [body, { type: "null" }] };
  for (const schema of ["SessionsResponse", "SessionMessagesResponse"]) {
    const cursor = read.field(contract.components.schemas[schema], "cursor", "object");
    expect(schemaObject(cursor.properties).next).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
  }
  expect(() => assertV2SharedCapabilities(contract, "2.1.0")).not.toThrow();
});

it.each(["2.0.24", "2.0.26"] as const)(
  "accepts integer timestamp/token response subsets of official %s",
  (version) => {
    const contract = v2OfficialContract(version);
    const schemas = contract.components.schemas;
    for (const name of ["User", "Synthetic", "Shell", "Skill", "Assistant", "Idle"]) {
      const time = schemaObject(
        schemaObject(schemas[`Session.Message.${name}`]!.properties.time).properties,
      );
      time.created = { type: "integer" };
      if (name === "Assistant") time.completed = { type: "integer" };
    }
    const tokens = schemas["TokenUsage.Info"]!.properties;
    for (const key of ["input", "output", "reasoning"]) tokens[key] = { type: "integer" };
    const cache = schemaObject(schemaObject(tokens.cache).properties);
    for (const key of ["read", "write"]) cache[key] = { type: "integer" };
    expect(() => assertV2SharedCapabilities(contract, version)).not.toThrow();
  },
);

it("does not reverse response numeric compatibility or widen request acceptance", () => {
  const contract = v2OfficialContract();
  contract.components.schemas.ServerInfo!.properties.pid = { type: "number" };
  expect(() => assertV2SharedCapabilities(contract, "2.1.0")).toThrow("incompatible");
  const read = makeV2SchemaReader({});
  const field = { type: "object", properties: { value: { type: "integer" } } };
  expect(() => read.field(field, "value", "number")).not.toThrow();
  expect(() => read.input.field(field, "value", "number")).toThrow("Incompatible");
});
