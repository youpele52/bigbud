import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GitCommitSummary, GitStatusResult } from "@bigbud/contracts";

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
  gitListCommitsInfiniteQueryOptions: vi.fn(() => ({ queryKey: ["git", "commits"] })),
  gitCommitDetailsQueryOptions: vi.fn(() => ({ queryKey: ["git", "commit-details"] })),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");

  return {
    ...actual,
    useInfiniteQuery: vi.fn((options: { queryKey?: string[] }) => {
      const scope = options.queryKey?.[1];

      if (scope === "commits") {
        return {
          data: {
            pages: [
              {
                commits: [
                  {
                    sha: "abc123",
                    shortSha: "abc123",
                    subject: "Commit subject",
                    authorName: "Youpele Michael",
                    authoredAt: "2026-06-08T00:00:00.000Z",
                    isPushed: false,
                    tags: [],
                  },
                ],
                nextCursor: null,
              },
            ],
            pageParams: [0],
          },
          hasNextPage: false,
          isFetchingNextPage: false,
          isLoading: false,
          error: null,
          fetchNextPage: vi.fn(),
        };
      }

      return {
        data: null,
        hasNextPage: false,
        isFetchingNextPage: false,
        isLoading: false,
        error: null,
        fetchNextPage: vi.fn(),
      };
    }),
    useQuery: vi.fn((options: { queryKey?: string[] }) => {
      const scope = options.queryKey?.[1];

      if (scope === "status") {
        return { data: gitStatusResult, isLoading: false, error: null };
      }

      if (scope === "working-tree-diff") {
        return { data: { diff: "" }, isLoading: false, error: null };
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
import { GitPanelHistory } from "./GitPanelHistory";

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
    expect(markup).toContain("text-[11px] text-muted-foreground/80");
    expect(markup).toContain("29 changed files");
    expect(markup).toContain("Scroll for more changed files");
    expect(markup).toContain('aria-label="Show changes"');
    expect(markup).toContain('title="Changes"');
    expect(markup).toContain('aria-label="Show history"');
    expect(markup).toContain('title="History"');
    expect(markup).toContain('draggable="true"');
  });

  it("renders history rows with author, relative time, and not-pushed state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T00:02:00.000Z"));

    const history: GitCommitSummary[] = [
      {
        sha: "abc123",
        shortSha: "abc123",
        subject: "Commit subject",
        authorName: "Youpele Michael",
        authoredAt: "2026-06-08T00:00:00.000Z",
        isPushed: false,
        tags: ["v0.1.642-beta-2", "latest"],
      },
    ];

    const markup = renderToStaticMarkup(
      <GitPanelHistory
        commitDetails={null}
        detailError={null}
        hasMoreHistory={true}
        history={history}
        historyError={null}
        isLoadingDetails={false}
        isLoadingMoreHistory={false}
        onLoadMoreHistory={() => Promise.resolve()}
        onSelectCommit={() => undefined}
        selectedCommitSha="abc123"
        selectedCommitSummary={history[0] ?? null}
      />,
    );

    expect(markup).toContain("abc123 by Youpele Michael, 2m");
    expect(markup).toContain("v0.1.642-beta-2");
    expect(markup).toContain("latest");
    expect(markup).toContain('aria-label="Not pushed"');
    expect(markup).toContain("Scroll for older history");

    vi.useRealTimers();
  });

  it("renders selected commit tags in the detail panel", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T00:02:00.000Z"));

    const history: GitCommitSummary[] = [
      {
        sha: "abc123",
        shortSha: "abc123",
        subject: "Commit subject",
        authorName: "Youpele Michael",
        authoredAt: "2026-06-08T00:00:00.000Z",
        isPushed: true,
        tags: ["v0.1.642-beta-2", "stable"],
      },
    ];

    const markup = renderToStaticMarkup(
      <GitPanelHistory
        commitDetails={{
          sha: "abc123",
          shortSha: "abc123",
          subject: "Commit subject",
          authorName: "Youpele Michael",
          authoredAt: "2026-06-08T00:00:00.000Z",
          tags: ["v0.1.642-beta-2", "stable"],
          body: "",
          parents: [],
          files: [],
          diff: "",
        }}
        detailError={null}
        hasMoreHistory={false}
        history={history}
        historyError={null}
        isLoadingDetails={false}
        isLoadingMoreHistory={false}
        onLoadMoreHistory={() => Promise.resolve()}
        onSelectCommit={() => undefined}
        selectedCommitSha="abc123"
        selectedCommitSummary={history[0] ?? null}
      />,
    );

    expect(markup).toContain("v0.1.642-beta-2");
    expect(markup).toContain("stable");

    vi.useRealTimers();
  });
});
