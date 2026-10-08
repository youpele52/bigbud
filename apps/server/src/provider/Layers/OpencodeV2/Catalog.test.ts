import type { ModelInfo } from "@opencode/client";
import { describe, expect, it } from "vitest";

import { normalizeV2Catalog } from "./Catalog.ts";

const model: ModelInfo = {
  id: "model",
  modelID: "native-model",
  providerID: "provider-one",
  name: "Synthetic model",
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [{ id: "high" }],
  time: { released: 1 },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 1000, output: 100 },
};

describe("V2 independent model catalog normalization", () => {
  it("keeps same-slug subproviders distinct with V2 variant identities", () => {
    const result = normalizeV2Catalog(
      {
        location: { directory: "/synthetic" },
        data: [model, { ...model, providerID: "provider-two" }],
      },
      "/synthetic",
    );
    expect(result.map((entry) => entry.subProviderID)).toEqual(["provider-one", "provider-two"]);
    expect(result[0]?.capabilities?.reasoningEffortLevels).toEqual([
      { value: "high", label: "high" },
    ]);
  });
  it("rejects ambiguous ownership/identity and never marks disabled models available", () => {
    expect(() =>
      normalizeV2Catalog({ location: { directory: "/hostile" }, data: [model] }, "/synthetic"),
    ).toThrow();
    expect(() =>
      normalizeV2Catalog(
        { location: { directory: "/synthetic" }, data: [model, model] },
        "/synthetic",
      ),
    ).toThrow();
    expect(
      normalizeV2Catalog(
        { location: { directory: "/synthetic" }, data: [{ ...model, enabled: false }] },
        "/synthetic",
      ),
    ).toEqual([]);
  });
});
