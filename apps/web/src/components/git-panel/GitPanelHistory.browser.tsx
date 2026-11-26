import type {
  GitCommitDetails,
  GitCommitSummary,
  GitGetCommitDetailsInput,
  GitGetCommitFileDiffInput,
} from "@bigbud/contracts";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createElement } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { getCommitDetails, getCommitFileDiff } = vi.hoisted(() => ({
  getCommitDetails: vi.fn(),
  getCommitFileDiff: vi.fn(),
}));

vi.mock("~/rpc/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/rpc/nativeApi")>()),
  ensureNativeApi: () => ({ git: { getCommitDetails, getCommitFileDiff } }),
}));

import { gitCommitDetailsQueryOptions } from "~/lib/gitReactQuery";
import { GitPanelHistory } from "./GitPanelHistory";
import { useCommitSelection } from "./GitPanelHistory.selection";

const WORKSPACE = "/repo/project";
const history: GitCommitSummary[] = Array.from({ length: 6 }, (_, index) => ({
  sha: `${index}`.repeat(40),
  shortSha: `${index}`.repeat(7),
  subject: `Commit ${index}`,
  authors: [{ name: "T", email: null }],
  authoredAt: "2026-06-08T00:00:00.000Z",
  isPushed: true,
  tags: [],
}));

function details(sha: string): GitCommitDetails {
  const files = [
    ...Array.from({ length: 40 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      insertions: 1_000,
      deletions: 0,
    })),
    { path: "huge.json", insertions: 50_000, deletions: 0 },
  ];
  return {
    sha,
    shortSha: sha.slice(0, 7),
    subject: `Commit ${sha[0]}`,
    authors: [{ name: "T", email: null }],
    authoredAt: "2026-06-08T00:00:00.000Z",
    tags: [],
    body: "",
    parents: [],
    files,
  };
}

function Harness() {
  const { selectedSha, detailsSha, select } = useCommitSelection();
  const query = useQuery(
    gitCommitDetailsQueryOptions({
      cwd: WORKSPACE,
      commit: detailsSha ?? "",
      enabled: detailsSha !== null,
    }),
  );
  return createElement(GitPanelHistory, {
    workspaceRoot: WORKSPACE,
    commitDetails: query.data?.commit ?? null,
    detailError: null,
    hasMoreHistory: false,
    history,
    historyError: null,
    isLoadingDetails: query.isLoading,
    isLoadingHistory: false,
    isLoadingMoreHistory: false,
    onLoadMoreHistory: () => Promise.resolve(),
    onSelectCommit: select,
    selectedCommitSha: selectedSha,
    selectedCommitSummary: history.find((commit) => commit.sha === selectedSha) ?? null,
  });
}

function mount() {
  getCommitDetails.mockImplementation(async (input: GitGetCommitDetailsInput) => ({
    commit: details(input.commit),
  }));
  getCommitFileDiff.mockImplementation(async (input: GitGetCommitFileDiffInput) =>
    input.path === "huge.json" && input.limit !== "large"
      ? { path: input.path, diff: null, tooLarge: true, limitBytes: 262_144 }
      : {
          path: input.path,
          diff: `diff --git a/${input.path} b/${input.path}\n--- a/${input.path}\n+++ b/${input.path}\n@@ -0,0 +1 @@\n+line\n`,
          tooLarge: false,
          limitBytes: 262_144,
        },
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client }, createElement(Harness)));
}

const requested = () => getCommitDetails.mock.calls.map(([input]) => input.commit[0]);

afterEach(() => {
  getCommitDetails.mockReset();
  getCommitFileDiff.mockReset();
});

describe("GitPanelHistory", () => {
  it("fetches details immediately on click", async () => {
    await mount();
    await page.getByText("Commit 2").click();
    await vi.waitFor(() => expect(requested()).toEqual(["2"]), { timeout: 120 });
  });

  it("rapid arrow-key navigation fetches only the commit where the user stops", async () => {
    await mount();
    await page.getByText("Commit 0").click();
    await vi.waitFor(() => expect(requested()).toEqual(["0"]));
    for (let index = 0; index < 4; index += 1) await userEvent.keyboard("{ArrowDown}");
    // The highlight moves at once; no fetch for the commits passed through.
    await expect
      .element(page.getByText("Commit 4").element().closest<HTMLElement>("[data-commit-sha]")!)
      .toHaveClass(/bg-accent/);
    expect(requested()).toEqual(["0"]);
    await vi.waitFor(() => expect(requested()).toEqual(["0", "4"]));
  });

  it("lists every file of a large commit and loads one diff on demand", async () => {
    await mount();
    await page.getByText("Commit 1").click();
    await expect.element(page.getByText("src/file-39.ts")).toBeInTheDocument();
    await expect.element(page.getByText("huge.json")).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(getCommitFileDiff.mock.calls.map(([input]) => input.path)).toEqual(["src/file-0.ts"]),
    );
    await page.getByText("huge.json").click();
    await expect.element(page.getByText("This diff is too large to show.")).toBeInTheDocument();
    await page.getByRole("button", { name: "Load diff anyway" }).click();
    await vi.waitFor(() =>
      expect(getCommitFileDiff.mock.calls.at(-1)?.[0]).toMatchObject({
        path: "huge.json",
        limit: "large",
      }),
    );
    await expect.element(page.getByText("This diff is too large to show.")).not.toBeInTheDocument();
  });
});
