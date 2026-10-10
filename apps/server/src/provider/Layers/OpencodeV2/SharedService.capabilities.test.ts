import { expect, it } from "vitest";
import { assertV2SharedCapabilities } from "./SharedService.capabilities.ts";
import { sharedServiceTestContract } from "./SharedService.test.fixture.ts";

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
  expect(() => assertV2SharedCapabilities(contract, "2.0.24")).toThrow(`${name}.${field}`);
});

it("explains the actual missing capability and version without submitting a probe prompt", () => {
  const contract = sharedServiceTestContract();
  delete contract.paths["/api/session/{sessionID}/prompt"];
  expect(() => assertV2SharedCapabilities(contract, "2.0.24")).toThrow(
    "OpenCode v2 2.0.24 is missing the required session.prompt capability",
  );
});
