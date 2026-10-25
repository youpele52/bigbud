import { expect, it } from "vitest";
import { assertV2TextGenerationContract } from "./TextGeneration.contract.ts";

function contract() {
  const parameters = [
    { name: "sessionID", in: "path", required: true, schema: { type: "string", maxLength: 100 } },
  ];
  return {
    components: { schemas: {} },
    paths: {
      "/api/session/{sessionID}/generate": {
        post: {
          operationId: "session.generate",
          parameters,
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { prompt: { type: "string" } },
                  required: ["prompt"],
                  additionalProperties: false,
                },
              },
            },
          },
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["data"],
                    properties: {
                      data: {
                        type: "object",
                        required: ["text"],
                        properties: { text: { type: "string" } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/session/{sessionID}": {
        delete: { operationId: "session.remove", parameters, responses: { "204": {} } },
      },
    },
  };
}

it("accepts the public native transient-generation ABI and its real path bound", () => {
  expect(() => assertV2TextGenerationContract(contract())).not.toThrow();
});
it.each([
  "missing-route",
  "wrong-id",
  "missing-prompt",
  "new-required-input",
  "wrong-output",
  "short-id",
  "no-disposal",
])("rejects incompatible %s before creating auxiliary native history", (scenario) => {
  const value = contract();
  const generate = value.paths["/api/session/{sessionID}/generate"].post;
  if (scenario === "missing-route")
    delete (value.paths as Record<string, unknown>)["/api/session/{sessionID}/generate"];
  if (scenario === "wrong-id") generate.operationId = "legacy.generate";
  if (scenario === "missing-prompt")
    generate.requestBody.content["application/json"].schema.properties = {} as never;
  if (scenario === "new-required-input")
    generate.requestBody.content["application/json"].schema.required.push("unsupported");
  if (scenario === "wrong-output")
    generate.responses["200"].content[
      "application/json"
    ].schema.properties.data.properties.text.type = "number";
  if (scenario === "short-id") generate.parameters[0]!.schema.maxLength = 95;
  if (scenario === "no-disposal")
    value.paths["/api/session/{sessionID}"].delete.responses = {} as never;
  expect(() => assertV2TextGenerationContract(value)).toThrow();
});
