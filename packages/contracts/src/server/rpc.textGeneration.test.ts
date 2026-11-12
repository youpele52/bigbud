import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { RetryThreadTextGenerationInput } from "./rpc.textGeneration";

const valid = Schema.is(RetryThreadTextGenerationInput);
const base = { threadId: "thread", operation: "title" };
const consent = "authorize-new-budget-with-unresolved-history";

describe("metadata retry authorization input", () => {
  it("keeps ordinary Retry source-based with no implicit cost authorization", () => {
    expect(valid({ ...base, sourceActivityId: "failure" })).toBe(true);
    expect(valid({ ...base })).toBe(false);
    expect(
      valid({ ...base, sourceActivityId: "failure", acknowledgeHistoricalUncertainty: consent }),
    ).toBe(false);
  });
  it("requires an explicit acknowledgement and stable new request identity together", () => {
    expect(valid({ ...base, newRequestId: "new", acknowledgeHistoricalUncertainty: consent })).toBe(
      true,
    );
    expect(valid({ ...base, newRequestId: "new" })).toBe(false);
    expect(valid({ ...base, acknowledgeHistoricalUncertainty: consent })).toBe(false);
    expect(valid({ ...base, newRequestId: "new", acknowledgeHistoricalUncertainty: "yes" })).toBe(
      false,
    );
    expect(
      valid({
        ...base,
        sourceActivityId: "old",
        newRequestId: "new",
        acknowledgeHistoricalUncertainty: consent,
      }),
    ).toBe(false);
  });
});
