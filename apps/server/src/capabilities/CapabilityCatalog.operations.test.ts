import { describe, expect, it } from "vitest";

import {
  CAPABILITY_GUIDE_CHARACTER_LIMIT,
  CAPABILITY_SEARCH_RESULT_LIMIT,
  readCapabilityGuide,
  searchCapabilities,
} from "./CapabilityCatalog.operations.ts";

describe("capability catalog operations", () => {
  it("searches by task keywords with bounded results", () => {
    const result = searchCapabilities("create delegated child thread");
    expect(result.matches[0]?.id).toBe("thread.create");
    expect(result.matches.length).toBeLessThanOrEqual(CAPABILITY_SEARCH_RESULT_LIMIT);
  });

  it("lists a bounded catalog for an empty query", () => {
    const result = searchCapabilities("");
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.length).toBeLessThanOrEqual(CAPABILITY_SEARCH_RESULT_LIMIT);
  });

  it("reads bounded sections by ID or logical URI", () => {
    const workflow = readCapabilityGuide({
      capabilityId: "bigbud://capabilities/thread.create",
      section: "workflow",
    });
    expect(workflow.content).toContain("create_thread");
    expect(workflow.content.length).toBeLessThanOrEqual(CAPABILITY_GUIDE_CHARACTER_LIMIT);
    expect(readCapabilityGuide({ capabilityId: "thread.create" }).section).toBe("summary");
  });

  it("rejects unknown capability IDs", () => {
    expect(() => readCapabilityGuide({ capabilityId: "missing" })).toThrow(
      "Unknown capability: missing",
    );
  });
});
