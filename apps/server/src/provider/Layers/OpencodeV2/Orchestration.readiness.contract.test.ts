import { expect, it } from "vitest";
import { assertV2BootstrapContract } from "./Orchestration.readiness.contract.ts";
import { v2ReadinessFailure, v2ReadinessSetupReason } from "./Orchestration.readiness.failure.ts";

it("reports safe mismatch field names without exposing native values", () => {
  const expected = {
    issuer: "issuer",
    protocol: "rpc",
    artifactDigest: "new",
    bootstrapDigest: "new",
    bootstrapAbi: "v4",
    compatibilityDigest: "compatible",
    schemaDigest: "schema",
    nativeVersion: "2.2.6",
    tools: ["a", "b"],
  };
  expect(() =>
    assertV2BootstrapContract({ ...expected, tools: ["b", "a"] }, expected),
  ).not.toThrow();
  let error: unknown;
  try {
    assertV2BootstrapContract(
      { ...expected, bootstrapAbi: "private-native-value", tools: ["a"] },
      expected,
    );
  } catch (caught) {
    error = caught;
  }
  const failure = v2ReadinessFailure(error);
  expect(failure.fields).toEqual(["bootstrapAbi", "tools"]);
  expect(v2ReadinessSetupReason(failure, "Recovery required")).toContain(
    "fields=bootstrapAbi,tools",
  );
  expect(String(error)).not.toContain("private-native-value");
});
