import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GitStatusResult } from "@bigbud/contracts";

const gitStatusResult: GitStatusResult = {
  isRepo: true,
  hasOriginRemote: true,
  isDefaultBranch: false,
  branch: "dev",
  hasWorkingTreeChanges: true,
  workingTree: {
    files: Array.from({ length: 29 }, (_, index) => ({
      path: `file-${index + 1}.ts`,
      insertions: 1,
      deletions: 0,
    })),
    insertions: 29,
    deletions: 0,
  },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

vi.mock("~/hooks/useResolvedGitWorkspace", () => ({
  useResolvedGitWorkspace: () => ({
    cwd: "/repo/project",
    executionTargetId: undefined,
  }),
}));

vi.mock("~/lib/gitReactQuery", () => ({
  gitStatusQueryOptions: vi.fn(() => ({ queryKey: ["git", "status"] })),
  gitWorkingTreeDiffQueryOptions: vi.fn(() => ({ queryKey: ["git", "working-tree-diff"] })),
  gitListCommitsQueryOptions: vi.fn(() => ({ queryKey: ["git", "commits"] })),
  gitCommitDetailsQueryOptions: vi.fn(() => ({ queryKey: ["git", "commit-details"] })),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");

  return {
    ...actual,
    useQuery: vi.fn((options: { queryKey?: string[] }) => {
      const scope = options.queryKey?.[1];

      if (scope === "status") {
        return { data: gitStatusResult, isLoading: false, error: null };
      }

      if (scope === "working-tree-diff") {
        return { data: { diff: "" }, isLoading: false, error: null };
      }

      if (scope === "commits") {
        return {
          data: {
            commits: [
              {
                sha: "abc123",
                shortSha: "abc123",
                subject: "Commit subject",
                authorName: "Youpele Michael",
                authoredAt: "2026-06-08T00:00:00.000Z",
              },
            ],
          },
          isLoading: false,
          error: null,
        };
      }

      if (scope === "commit-details") {
        return {
          data: {
            commit: {
              sha: "abc123",
              shortSha: "abc123",
              subject: "Commit subject",
              authorName: "Youpele Michael",
              authoredAt: "2026-06-08T00:00:00.000Z",
              body: "Commit body",
              parents: [],
              files: [],
              diff: "",
            },
          },
          isLoading: false,
          error: null,
        };
      }

      return { data: null, isLoading: false, error: null };
    }),
  };
});

vi.mock("./GitPatchViewer", () => ({
  GitPatchViewer: () => <div data-testid="git-patch-viewer" />,
}));

import { GitPanelContent } from "./GitPanel";

describe("GitPanelContent", () => {
  const localStorageMock = {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
  };

  vi.stubGlobal("localStorage", localStorageMock);

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders status text, matching file count, and toggle labels", () => {
    const markup = renderToStaticMarkup(<GitPanelContent activeThreadId={null} />);

    expect(markup).toContain("Up to date");
    expect(markup).toContain("text-xs text-muted-foreground/80");
    expect(markup).toContain("29 changed files");
    expect(markup).toContain('aria-label="Show changes"');
    expect(markup).toContain('title="Changes"');
    expect(markup).toContain('aria-label="Show history"');
    expect(markup).toContain('title="History"');
  });
});
