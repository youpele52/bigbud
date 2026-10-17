import { expect, it } from "vitest";
import { assertV2CanonicalNativeApi } from "./NativeCompatibility.api.ts";
import { v2CanonicalApiFixture } from "./NativeCompatibility.api.fixture.ts";
import { makeV2SchemaReader, schemaObject } from "./SharedService.schema.ts";
import { resolveV2NativeQualification } from "./NativeCompatibility.qualification.ts";
import { V2_COMPATIBILITY_DIGEST } from "./Orchestration.compatibility.ts";

it("a finite independent official contract can pass API checks without claiming semantic qualification", () => {
  expect(assertV2CanonicalNativeApi(v2CanonicalApiFixture(), "2.1.0")).toMatch(/^[a-f0-9]{64}$/);
  expect(() =>
    resolveV2NativeQualification("2.1.0", V2_COMPATIBILITY_DIGEST, "darwin", "arm64"),
  ).toThrow("qualification is required");
});

it("unrelated paths, optional request additions and equivalent local aliases do not change the consumed digest", () => {
  const contract = v2CanonicalApiFixture(),
    first = assertV2CanonicalNativeApi(contract, "2.0.28");
  contract.paths["/unused"] = { get: {} };
  const op = schemaObject(contract.paths["/api/rpc/{rpcID}/{method}"]!.post);
  const read = makeV2SchemaReader(contract.components.schemas);
  schemaObject(read.input.content(op.requestBody).properties).future = { type: "string" };
  const renamed = JSON.parse(
    JSON.stringify(contract).replaceAll("Location.PublicRef", "EquivalentLocation"),
  );
  expect(assertV2CanonicalNativeApi(renamed, "2.0.28")).toBe(first);
});

it.each([
  "missing-route",
  "operation-id",
  "required-query",
  "location-style",
  "rpc-input",
  "rpc-output",
  "debug-wrapper",
  "shell-security-state",
  "plugin-security-state",
  "config-unknown-source",
  "external-reference",
  "cycle",
  "unknown-idle-outcome",
  "narrowed-rpc-input",
  "narrowed-rpc-output",
])("rejects canonical-only contract regression %s", (scenario) => {
  const contract = v2CanonicalApiFixture(),
    read = makeV2SchemaReader(contract.components.schemas);
  const op = (route: string, method = "get") => schemaObject(contract.paths[route]![method]);
  const rpc = op("/api/rpc/{rpcID}/{method}", "post");
  if (scenario === "missing-route") delete contract.paths["/api/config"];
  if (scenario === "operation-id") op("/api/config").operationId = "config.set";
  if (scenario === "required-query")
    (op("/api/config").parameters as unknown[]).push({
      in: "query",
      name: "new",
      required: true,
      schema: { type: "string" },
    });
  if (scenario === "location-style")
    schemaObject((op("/api/config").parameters as unknown[])[0]).style = "form";
  if (scenario === "rpc-input") read.input.content(rpc.requestBody).required = ["unsupported"];
  if (scenario === "rpc-output")
    delete schemaObject(read.content(schemaObject(rpc.responses)["200"]).properties).output;
  if (scenario === "narrowed-rpc-input")
    schemaObject(read.input.content(rpc.requestBody).properties).input = { type: "string" };
  if (scenario === "narrowed-rpc-output")
    schemaObject(read.content(schemaObject(rpc.responses)["200"]).properties).output = {
      anyOf: [{ type: "string" }, { type: "null" }],
    };
  if (scenario === "debug-wrapper")
    read.content(schemaObject(op("/api/debug/location").responses)["200"]).type = "object";
  if (scenario === "shell-security-state")
    contract.components.schemas["Shell.Info"]!.properties.status = {
      type: "string",
      enum: ["running", "unknown"],
    };
  if (scenario === "plugin-security-state")
    contract.components.schemas["Plugin.State"]!.anyOf = [
      {
        type: "object",
        properties: { status: { type: "string", enum: ["active", "future"] } },
        required: ["status"],
      },
    ];
  if (scenario === "config-unknown-source")
    contract.components.schemas["Config.Entry"]!.anyOf = [
      {
        type: "object",
        properties: { type: { type: "string", enum: ["unknown"] } },
        required: ["type"],
      },
    ];
  if (scenario === "external-reference")
    contract.components.schemas["Location.PublicRef"] = {
      properties: {},
      $ref: "https://invalid.example/schema",
    };
  if (scenario === "cycle")
    contract.components.schemas["Location.PublicRef"] = {
      properties: {},
      $ref: "#/components/schemas/Location.PublicRef",
    };
  if (scenario === "unknown-idle-outcome") {
    const idle = contract.components.schemas["Session.Message.Idle"]!;
    schemaObject(idle.properties).outcome = {
      type: "string",
      enum: ["succeeded", "failed", "interrupted", "future"],
    };
  }
  expect(() => assertV2CanonicalNativeApi(contract, "2.0.28")).toThrow("no installation");
});
