import { describe, expect, it } from "vitest";

import {
  compareTaskFreshness,
  isTaskFreshnessNewer,
  mergeTaskPatch,
  toBoundedRedactedDisplayValue,
  toBoundedRedactedText,
} from "./providerRuntime";

describe("compareTaskFreshness", () => {
  it("orders source priority, snapshots, native revisions, and observation ordinals", () => {
    const baseline = {
      sourcePriority: 1,
      snapshotGeneration: 2,
      providerRevision: 4,
      providerMessageId: "message-a",
      observedOrdinal: 3,
    } as const;

    expect(compareTaskFreshness(baseline, { ...baseline, observedOrdinal: 4 })).toBeLessThan(0);
    expect(isTaskFreshnessNewer({ ...baseline, snapshotGeneration: 3 }, baseline)).toBe(true);
    expect(isTaskFreshnessNewer({ ...baseline, sourcePriority: 0 }, baseline)).toBe(false);
  });
});

describe("mergeTaskPatch", () => {
  it("preserves omitted fields and applies null as an explicit clear", () => {
    const merged = mergeTaskPatch(
      { subject: "Task", detail: "existing", status: "pending" },
      { detail: undefined, status: "completed" },
    );
    expect(merged).toEqual({ subject: "Task", detail: "existing", status: "completed" });

    expect(mergeTaskPatch(merged, { detail: null })).toEqual({
      subject: "Task",
      detail: null,
      status: "completed",
    });
  });
});

describe("bounded activity display values", () => {
  it("bounds and redacts strings and nested values", () => {
    expect(
      toBoundedRedactedText("Bearer secret-value https://example.com/private", { maxChars: 80 }),
    ).toBe("[redacted] [redacted-url]");
    expect(
      toBoundedRedactedDisplayValue(
        {
          output: "sk_abcdefghi",
          apiToken: "not-a-token-shaped-value",
          nested: { url: "https://private.example/path" },
        },
        { maxDepth: 1 },
      ),
    ).toEqual({ output: "[redacted]", apiToken: "[redacted]", nested: "…" });
  });
});
