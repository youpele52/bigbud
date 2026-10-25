import type { GitStatusResult } from "@bigbud/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GitPanelSyncControl } from "./GitPanelSyncControl";

function status(overrides: Partial<GitStatusResult> = {}): GitStatusResult {
  return {
    isRepo: true,
    hasOriginRemote: true,
    isDefaultBranch: false,
    branch: "dev",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

function markup(gitStatus: GitStatusResult | null, gitStatusError?: string) {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <GitPanelSyncControl
        cwd="/repo"
        gitStatus={gitStatus}
        {...(gitStatusError !== undefined ? { gitStatusError } : {})}
      />
    </QueryClientProvider>,
  );
}

describe("GitPanelSyncControl", () => {
  it("shows Pull when the branch is behind", () => {
    const output = markup(status({ behindCount: 2 }));

    expect(output).toContain("Pull 2 commits");
    expect(output).not.toContain("Push");
  });

  it("shows Pull before Push when the branch has diverged", () => {
    const output = markup(status({ aheadCount: 3, behindCount: 2 }));

    expect(output.indexOf("Pull 2 commits")).toBeLessThan(output.indexOf("Push 3 commits"));
  });

  it("shows Fetch when there are no directional commits", () => {
    expect(markup(status())).toContain("Fetch");
  });

  it("keeps a blocked Pull visible for dirty worktrees", () => {
    const output = markup(status({ behindCount: 1, hasWorkingTreeChanges: true }));

    expect(output).toContain("Pull 1 commit");
  });

  it("exposes investigation recovery when initial status is unavailable", () => {
    const output = markup(null, "Remote Git transport disconnected.");

    expect(output).toContain("Investigate Git status");
    expect(output).toContain("Remote status unavailable");
  });
});
