import { ORGANIZATION_THREAD_LIMIT } from "@bigbud/contracts/constants/organization.constant.ts";
import { describe, expect, it } from "vitest";
import { organizationPausedCopy } from "./organizationStatusCopy";

const status = (
  state: "syncing" | "healthy" | "paused",
  reason?: "thread-limit" | "capture-time",
) => ({
  state,
  changedAtMs: 0,
  installation: "existing" as const,
  ...(reason ? { reason } : {}),
});

describe("organizationPausedCopy", () => {
  it("says nothing unless paused", () => {
    expect(organizationPausedCopy(undefined)).toBeNull();
    expect(organizationPausedCopy(status("healthy"))).toBeNull();
    expect(organizationPausedCopy(status("syncing"))).toBeNull();
  });
  it("names the recovery path for each pause", () => {
    expect(organizationPausedCopy(status("paused"))).toMatch(/retries on its own.*move a thread/);
    expect(organizationPausedCopy(status("paused", "thread-limit"))).toMatch(
      /100,000 threads.*deleting some.*change any Inyosira setting/,
    );
    // The copy follows the shared limit instead of a second hardcoded number.
    expect(organizationPausedCopy(status("paused", "thread-limit"))).toContain(
      `more than ${ORGANIZATION_THREAD_LIMIT.toLocaleString("en-US")} threads`,
    );
    expect(organizationPausedCopy(status("paused", "capture-time"))).toMatch(
      /took too long.*Change any Inyosira setting/,
    );
    for (const reason of [undefined, "thread-limit", "capture-time"] as const)
      expect(organizationPausedCopy(status("paused", reason))).toMatch(
        /You can still move threads/,
      );
  });
});
