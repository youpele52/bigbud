import { ThreadId, type GitStatusResult } from "@bigbud/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const THREAD_ID = ThreadId.makeUnsafe("git-sync-thread");
const WORKSPACE = "/repo/project";
const EXECUTION_TARGET = "ssh:devbox";

const {
  fetchMutationSpy,
  fetchOptionsSpy,
  focusComposerSpy,
  pullMutationSpy,
  queryStatusRef,
  runGitActionWithToastSpy,
} = vi.hoisted(() => ({
  fetchMutationSpy: vi.fn(),
  fetchOptionsSpy: vi.fn(),
  focusComposerSpy: vi.fn(),
  pullMutationSpy: vi.fn(),
  queryStatusRef: {
    current: null as (() => Promise<GitStatusResult>) | null,
  },
  runGitActionWithToastSpy: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useIsMutating: vi.fn(() => 0),
    useMutation: vi.fn((options: { __kind?: string }) => {
      if (options.__kind === "pull") {
        return { mutateAsync: pullMutationSpy, isPending: false };
      }
      if (options.__kind === "fetch") {
        return { mutateAsync: fetchMutationSpy, isPending: false };
      }
      return { mutateAsync: vi.fn(), isPending: false };
    }),
  };
});

vi.mock("~/components/git/GitActionsControl.runner", () => ({
  useGitActionRunner: () => ({
    isRunning: false,
    runGitActionWithToast: runGitActionWithToastSpy,
  }),
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: {
    add: vi.fn(),
    promise: vi.fn(),
  },
}));

vi.mock("~/lib/chatFocus", () => ({
  focusContextualChatTarget: focusComposerSpy,
}));

vi.mock("~/lib/gitReactQuery", () => ({
  createGitMutationOperationId: vi.fn(() => "git-operation-1"),
  gitFetchMutationOptions: vi.fn((input: unknown) => {
    fetchOptionsSpy(input);
    return { __kind: "fetch" };
  }),
  gitMutationKeys: {
    fetch: vi.fn(() => ["git", "fetch"]),
    pull: vi.fn(() => ["git", "pull"]),
    runStackedAction: vi.fn(() => ["git", "stacked"]),
  },
  gitPullMutationOptions: vi.fn(() => ({ __kind: "pull" })),
  gitStatusQueryOptions: vi.fn(() => ({
    queryKey: ["git", "status", WORKSPACE],
    queryFn: () => {
      if (!queryStatusRef.current) {
        return Promise.reject(new Error("status unavailable"));
      }
      return queryStatusRef.current();
    },
  })),
}));

vi.mock("./GitPanelSyncIssueDialog", () => ({
  GitPanelSyncIssueDialog: (props: {
    issue: string;
    onPreparePrompt: (preference: "investigate") => void;
  }) =>
    createElement(
      "div",
      { role: "dialog" },
      createElement("span", null, props.issue),
      createElement(
        "button",
        { onClick: () => props.onPreparePrompt("investigate") },
        "Prepare investigation prompt",
      ),
    ),
}));

import { useComposerDraftStore } from "~/stores/composer";
import { GitPanelSyncControl } from "./GitPanelSyncControl";

function status(overrides: Partial<GitStatusResult> = {}): GitStatusResult {
  return {
    isRepo: true,
    hasOriginRemote: true,
    isDefaultBranch: false,
    branch: "feature/sync",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function mountControl(input: {
  gitStatus: GitStatusResult | null;
  gitStatusError?: string;
  executionTargetId?: string;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <GitPanelSyncControl
        activeThreadId={THREAD_ID}
        cwd={WORKSPACE}
        gitStatus={input.gitStatus}
        {...(input.gitStatusError ? { gitStatusError: input.gitStatusError } : {})}
        {...(input.executionTargetId ? { executionTargetId: input.executionTargetId } : {})}
      />
    </QueryClientProvider>,
    { container: host },
  );
  return { host, screen, queryClient };
}

afterEach(() => {
  queryStatusRef.current = null;
  fetchMutationSpy.mockReset();
  fetchOptionsSpy.mockClear();
  focusComposerSpy.mockClear();
  pullMutationSpy.mockReset();
  runGitActionWithToastSpy.mockClear();
  useComposerDraftStore.getState().clearDraftThread(THREAD_ID);
});

describe("GitPanelSyncControl interactions", () => {
  it("prepares an investigation prompt after repeated status failure", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_ID, "Keep this draft.");
    queryStatusRef.current = () => Promise.reject(new Error("still disconnected"));
    const mounted = await mountControl({
      gitStatus: null,
      gitStatusError: "initial disconnect",
    });

    try {
      await page.getByRole("button", { name: "Investigate Git status" }).click();
      await expect.element(page.getByRole("dialog")).toBeInTheDocument();
      await page.getByRole("button", { name: "Prepare investigation prompt" }).click();
      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toContain(
          "Git status: unavailable",
        );
      });
      const prompt = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt ?? "";
      expect(prompt).toContain("Keep this draft.");
      expect(prompt).toContain("still disconnected");
      expect(focusComposerSpy).toHaveBeenCalledOnce();
      expect(runGitActionWithToastSpy).not.toHaveBeenCalled();
    } finally {
      await mounted.screen.unmount();
      mounted.host.remove();
    }
  });

  it("allows only one confirmation path for rapid duplicate clicks", async () => {
    const confirmation = deferred<GitStatusResult>();
    pullMutationSpy.mockResolvedValue({
      status: "pulled",
      branch: "feature/sync",
      upstreamBranch: "origin/feature/sync",
    });
    queryStatusRef.current = () => confirmation.promise;
    const mounted = await mountControl({ gitStatus: status({ behindCount: 1 }) });

    try {
      const pull = page.getByRole("button", { name: "Pull 1 commit" });
      const pullElement = pull.element() as HTMLButtonElement;
      pullElement.click();
      pullElement.click();
      confirmation.resolve(status({ behindCount: 1 }));
      await vi.waitFor(() => expect(pullMutationSpy).toHaveBeenCalledOnce());
    } finally {
      await mounted.screen.unmount();
      mounted.host.remove();
    }
  });

  it("opens an issue without mutating dirty or diverged worktrees", async () => {
    for (const gitStatus of [
      status({ behindCount: 1, hasWorkingTreeChanges: true }),
      status({ aheadCount: 1, behindCount: 1 }),
    ]) {
      queryStatusRef.current = () => Promise.resolve(gitStatus);
      const mounted = await mountControl({ gitStatus });
      try {
        await page.getByRole("button", { name: "Pull 1 commit" }).click();
        await expect.element(page.getByRole("dialog")).toBeInTheDocument();
        expect(pullMutationSpy).not.toHaveBeenCalled();
        expect(runGitActionWithToastSpy).not.toHaveBeenCalled();
      } finally {
        await mounted.screen.unmount();
        mounted.host.remove();
      }
    }
  });

  it("forwards the remote target and reports a failed mutation", async () => {
    queryStatusRef.current = () => Promise.resolve(status());
    fetchMutationSpy.mockRejectedValueOnce(new Error("network unavailable"));
    const mounted = await mountControl({
      gitStatus: status(),
      executionTargetId: EXECUTION_TARGET,
    });

    try {
      await page.getByRole("button", { name: "Fetch" }).click();
      await vi.waitFor(() => expect(fetchMutationSpy).toHaveBeenCalledOnce());
      expect(fetchOptionsSpy).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: WORKSPACE, executionTargetId: EXECUTION_TARGET }),
      );
      await expect.element(page.getByRole("dialog")).toBeInTheDocument();
      await expect.element(page.getByText("operation_failed")).toBeInTheDocument();
    } finally {
      await mounted.screen.unmount();
      mounted.host.remove();
    }
  });
});
