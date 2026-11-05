import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  GetOrganizationThreadSummariesInput,
  GetOrganizationThreadSummariesResult,
} from "./orchestration.catalog.organization";

const decodeInput = Schema.decodeUnknownSync(GetOrganizationThreadSummariesInput);
const decodeResult = Schema.decodeUnknownSync(GetOrganizationThreadSummariesResult);
const page = { projectionSequence: 1, state: "later", threads: [] };

describe("organization thread totals", () => {
  it("keeps counting opt-in and accepts legacy pages without totals", () => {
    expect(decodeInput({ state: "later" }).includeTotalCount).toBeUndefined();
    expect(decodeInput({ state: "later", includeTotalCount: true }).includeTotalCount).toBe(true);
    expect(decodeResult(page).totalCount).toBeUndefined();
  });

  it.each([0, 1, 250])("accepts a full group total of %s", (totalCount) => {
    expect(decodeResult({ ...page, totalCount }).totalCount).toBe(totalCount);
  });

  it.each([-1, 1.5])("rejects an invalid total of %s", (totalCount) => {
    expect(() => decodeResult({ ...page, totalCount })).toThrow();
  });
});
