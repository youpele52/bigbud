import { describe, expect, it } from "vitest";

import { DIRECT_CLEANUP_RESOURCE_KINDS } from "./DirectResourceCleanupExecutor.ts";

describe("direct cleanup resource partition", () => {
  it("contains only the six approved plain resource kinds", () => {
    expect(DIRECT_CLEANUP_RESOURCE_KINDS).toEqual([
      "attachment",
      "provider-log",
      "terminal-history",
      "project-memory",
      "project-notes",
      "project-kanban",
    ]);
    expect(DIRECT_CLEANUP_RESOURCE_KINDS).not.toContain("managed-worktree");
  });
});
