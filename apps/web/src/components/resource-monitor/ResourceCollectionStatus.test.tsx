import type { MonitorCollectionStatus } from "@bigbud/contracts/system-monitor/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ResourceCollectionStatus } from "./ResourceCollectionStatus";

const retrying: MonitorCollectionStatus = {
  state: "retrying",
  attempts: 2,
  retryAfterMs: 2500,
  reason: "Sensor refresh failed",
  epoch: 4,
};

describe("ResourceCollectionStatus", () => {
  it("shows a relative retry delay without treating it as a timestamp", () => {
    const markup = renderToStaticMarkup(
      <ResourceCollectionStatus status={retrying} onRetry={vi.fn()} />,
    );
    expect(markup).toContain("Resource collection is retrying");
    expect(markup).toContain("Attempt 2 · retry delay 3 s");
    expect(markup).toContain("Sensor refresh failed");
    expect(markup).not.toContain("Retry collection</button>");
  });

  it("offers a collection retry only after failure, and clears on healthy", () => {
    const failed = renderToStaticMarkup(
      <ResourceCollectionStatus status={{ ...retrying, state: "failed" }} onRetry={vi.fn()} />,
    );
    expect(failed).toContain("Resource collection failed");
    expect(failed).toContain("Retry collection");
    expect(
      renderToStaticMarkup(
        <ResourceCollectionStatus status={{ ...retrying, state: "healthy" }} onRetry={vi.fn()} />,
      ),
    ).toBe("");
  });
});
