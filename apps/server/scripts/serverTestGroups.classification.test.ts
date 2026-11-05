import { describe, expect, it } from "vitest";

import { classifyTestFileRun } from "./serverTestGroups.classification.ts";
import type { ProbeRecord } from "./serverTestGroups.guard.types.ts";

const probe: ProbeRecord = { file: "src/example.test.ts", touches: [] };

describe("server test group classification", () => {
  it("accepts a fully passing file with a completed probe", () => {
    expect(
      classifyTestFileRun(
        { status: "passed", assertionResults: [{ status: "passed" }, { status: "passed" }] },
        probe,
      ),
    ).toBe("passed");
  });

  it.each([
    ["mixed passed and skipped", [{ status: "passed" }, { status: "pending" }]],
    ["all skipped", [{ status: "pending" }]],
    ["failed assertions", [{ status: "failed" }]],
    ["missing assertions", undefined],
    ["empty assertions", []],
  ])("rejects a passed file with %s", (_, assertionResults) => {
    expect(
      classifyTestFileRun(
        { status: "passed", ...(assertionResults === undefined ? {} : { assertionResults }) },
        probe,
      ),
    ).toBe("incomplete");
  });

  it.each(["failed", "skipped", "pending"])("preserves a %s file status", (status) => {
    expect(classifyTestFileRun({ status, assertionResults: [{ status: "passed" }] }, probe)).toBe(
      status,
    );
    expect(classifyTestFileRun({ status }, undefined)).toBe(status);
  });

  it("marks a passed file without a probe as unfinished", () => {
    expect(
      classifyTestFileRun(
        { status: "passed", assertionResults: [{ status: "passed" }] },
        undefined,
      ),
    ).toBe("unfinished");
  });
});
