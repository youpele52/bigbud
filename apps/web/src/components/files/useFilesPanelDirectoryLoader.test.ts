import { describe, expect, it } from "vitest";

import { shouldQueueForceDirectoryRefresh } from "./useFilesPanelDirectoryLoader";

describe("shouldQueueForceDirectoryRefresh", () => {
  it("queues a forced refresh while a directory load is in flight", () => {
    expect(shouldQueueForceDirectoryRefresh(true, true)).toBe(true);
  });

  it("does not queue a forced refresh when the directory is idle", () => {
    expect(shouldQueueForceDirectoryRefresh(false, true)).toBe(false);
  });

  it("does not queue a non-forced refresh while loading", () => {
    expect(shouldQueueForceDirectoryRefresh(true, false)).toBe(false);
    expect(shouldQueueForceDirectoryRefresh(true, undefined)).toBe(false);
  });
});
