import { expect, it } from "vitest";
import {
  assertV2SharedCapabilities,
  V2_SHARED_REQUIRED_OPERATIONS,
} from "./SharedService.capabilities.ts";
import { sharedServiceTestContract } from "./SharedService.test.fixture.ts";

it.each(V2_SHARED_REQUIRED_OPERATIONS)("requires %s %s (%s)", (method, route, operation) => {
  const contract = sharedServiceTestContract();
  delete contract.paths[route]![method];
  expect(() => assertV2SharedCapabilities(contract, "2.1.0")).toThrow(operation);
});

it.each(["nested-required", "required-query", "required-body", "permission-enum"])(
  "rejects incompatible %s",
  (scenario) => {
    const contract = sharedServiceTestContract();
    if (scenario === "nested-required")
      Object.assign(contract.components.schemas["Model.Ref"]!, {
        required: ["id", "providerID", "variant"],
      });
    if (scenario === "required-query")
      (contract.paths["/api/session"]!.get as Record<string, unknown>).parameters = [
        { name: "projectID", in: "query", required: true, schema: { type: "string" } },
      ];
    if (scenario === "required-body")
      (
        contract.paths["/api/session/{sessionID}/inbox/{inboxID}"]!.delete as Record<
          string,
          unknown
        >
      ).requestBody = { required: true };
    if (scenario === "permission-enum")
      Object.assign(contract.components.schemas["Permission.Ruleset"]!, {
        items: {
          type: "object",
          properties: {
            action: { type: "string" },
            resource: { type: "string" },
            effect: { type: "string", enum: ["allow"] },
          },
        },
      });
    expect(() => assertV2SharedCapabilities(contract, "2.1.0")).toThrow("incompatible");
  },
);

it("permits additive native contracts but requires the ownership/model/auth shapes", () => {
  const contract = sharedServiceTestContract();
  contract.paths["/api/future"] = { get: { operationId: "future", responses: { "200": {} } } };
  expect(() => assertV2SharedCapabilities(contract, "2.0.24")).not.toThrow();
});

it.each([
  ["ServerInfo", "pid"],
  ["Session.Info", "permissions"],
  ["Session.Info", "metadata"],
  ["Model.Info", "variants"],
  ["Integration.Info", "connections"],
])("rejects changed %s.%s contract despite matching runtime text", (name, field) => {
  const contract = sharedServiceTestContract();
  contract.components.schemas[name]!.properties[field] = { type: "unknown" };
  expect(() => assertV2SharedCapabilities(contract, "2.0.24")).toThrow("incompatible");
});

it("accepts renamed and inlined equivalent schemas without trusting component names", () => {
  const contract = sharedServiceTestContract();
  let encoded = JSON.stringify(contract).replaceAll("Session.Info", "RenamedSession");
  const renamed = JSON.parse(encoded);
  expect(() => assertV2SharedCapabilities(renamed, "2.1.0")).not.toThrow();
  encoded = encoded.replaceAll(
    JSON.stringify({ $ref: "#/components/schemas/RenamedSession" }),
    JSON.stringify(renamed.components.schemas.RenamedSession),
  );
  expect(() => assertV2SharedCapabilities(JSON.parse(encoded), "2.1.0")).not.toThrow();
});

it.each([
  "new-required-input",
  "wrong-wrapper",
  "wrong-stream",
  "cyclic-ref",
  "remote-ref",
  "missing-path-parameter",
])("rejects %s", (scenario) => {
  const contract = sharedServiceTestContract();
  const prompt = contract.paths["/api/session/{sessionID}/prompt"]!.post as Record<string, any>;
  if (scenario === "new-required-input")
    prompt.requestBody.content["application/json"].schema.required = ["newField"];
  if (scenario === "wrong-wrapper")
    prompt.responses["200"].content["application/json"].schema.properties = {};
  if (scenario === "missing-path-parameter") prompt.parameters = [];
  if (scenario === "wrong-stream")
    (contract.paths["/api/event"]!.get as any).responses["200"].content["text/event-stream"][
      "x-effect-stream"
    ].encoding = "ndjson";
  if (scenario === "cyclic-ref")
    Object.assign(contract.components.schemas["Session.Info"]!, {
      $ref: "#/components/schemas/Session.Info",
    });
  if (scenario === "remote-ref")
    Object.assign(contract.components.schemas["Session.Info"]!, {
      $ref: "https://example.com/schema",
    });
  expect(() => assertV2SharedCapabilities(contract, "2.1.0")).toThrow("incompatible");
});

it("explains the actual missing capability and version without submitting a probe prompt", () => {
  const contract = sharedServiceTestContract();
  delete contract.paths["/api/session/{sessionID}/prompt"];
  expect(() => assertV2SharedCapabilities(contract, "2.0.24")).toThrow(
    "OpenCode v2 2.0.24 is missing the required session.prompt capability",
  );
});
