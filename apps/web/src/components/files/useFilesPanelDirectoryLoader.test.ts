import { describe, expect, it } from "vitest";

import {
  isCurrentDirectoryRequest,
  shouldQueueForceDirectoryRefresh,
} from "./useFilesPanelDirectoryLoader";

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

describe("isCurrentDirectoryRequest", () => {
  it("rejects a directory response after its workspace generation changes", () => {
    expect(isCurrentDirectoryRequest(1, 2, 1, 1)).toBe(false);
  });

  it("rejects a superseded request in the current workspace", () => {
    expect(isCurrentDirectoryRequest(2, 2, 1, 2)).toBe(false);
  });

  it("accepts only the active request in its initiating workspace", () => {
    expect(isCurrentDirectoryRequest(2, 2, 3, 3)).toBe(true);
  });
});
