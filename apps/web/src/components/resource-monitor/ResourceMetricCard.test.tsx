import { describe, expect, it } from "vitest";

import { formatHistoryTooltipValue } from "./ResourceMetricCard";

describe("resource metric history tooltip values", () => {
  it("keeps missing samples unavailable instead of displaying them as zero", () => {
    expect(formatHistoryTooltipValue(null, (value) => value.toFixed(2))).toBe("—");
    expect(formatHistoryTooltipValue(undefined, (value) => value.toFixed(2))).toBe("—");
  });
});
