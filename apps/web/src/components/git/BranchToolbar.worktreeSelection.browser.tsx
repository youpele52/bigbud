import "../../index.css";
import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { WorktreeInventory } from "@bigbud/contracts/workspace/worktrees.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { useComposerDraftStore } from "../../stores/composer/composer.store";
import { resetComposerDraftStore } from "../../stores/composer/composer.store.test.utils";
import { useStore } from "../../stores/main";
import { makeThread } from "../../stores/main/main.store.test.helpers";
import { readOwnershipLedger } from "../../stores/ownership/ownershipLedger";
import {
  initializeOwnershipFromComposer,
  reconcileComposerFromOwnershipLedger,
} from "../../stores/ownership/ownershipLedger.reconcile";

const { api, toast } = vi.hoisted(() => ({
  api: {
    git: { refreshStatus: vi.fn(), listBranches: vi.fn(), checkout: vi.fn() },
    worktrees: { list: vi.fn(), select: vi.fn() },
    orchestration: { dispatchCommand: vi.fn() },
  },
  toast: vi.fn(),
}));
vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => api, ensureNativeApi: () => api }));
vi.mock("../ui/toast", () => ({ toastManager: { add: toast } }));
vi.mock("./BranchToolbarProjectMenu", () => ({ default: vi.fn(() => null) }));

import BranchToolbar from "./BranchToolbar";

const threadId = ThreadId.makeUnsafe("draft-worktree-selection"),
  projectId = ProjectId.makeUnsafe("project");
const listing: WorktreeInventory = {
  repository: "/repo/.git",
  checkoutPath: "/repo",
  linkedCount: 2,
  local: true,
  revision: 7,
  entries: [
    { path: "/repo", name: "repo", branch: "main", identity: "1:1", main: true },
    { path: "/trees/A", name: "A", branch: "branch-A", identity: "1:2", main: false },
    { path: "/trees/B", name: "B", branch: "branch-B", identity: "1:3", main: false },
  ].map((entry) =>
    Object.assign(entry, { head: "abc", bare: false, locked: null, prunable: null }),
  ),
};

beforeEach(async () => {
  vi.resetAllMocks();
  localStorage.clear();
  resetComposerDraftStore();
  useStore.setState({
    ...useStore.getInitialState(),
    projects: [
      { id: projectId, name: "Project", cwd: "/repo", defaultModelSelection: null, scripts: [] },
    ],
  });
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(projectId, threadId, { branch: "main", envMode: "local" });
  await initializeOwnershipFromComposer();
  api.worktrees.list.mockImplementation(async () => structuredClone(listing));
  api.git.refreshStatus.mockImplementation(async ({ cwd }: { cwd: string }) => ({
    branch: listing.entries.find((entry) => entry.path === cwd)?.branch ?? "main",
  }));
  api.git.listBranches.mockImplementation(async ({ cwd }: { cwd: string }) => ({
    branches: listing.entries.map((entry) => ({
      name: entry.branch!,
      current: entry.path === cwd,
      isDefault: entry.main,
      worktreePath: entry.path,
    })),
    isRepo: true,
    hasOriginRemote: false,
    nextCursor: null,
    totalCount: 3,
  }));
});

async function mount(isGitRepo = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const screen = await render(
    <QueryClientProvider client={client}>
      <BranchToolbar threadId={threadId} envLocked={false} isGitRepo={isGitRepo} />
    </QueryClientProvider>,
  );
  return { screen, client };
}

async function selectFromPicker(name: "A" | "B") {
  await page.getByRole("button", { name: /^Worktree:/ }).click();
  await page.getByText(name, { exact: true }).hover();
  await page.getByRole("menuitem", { name: "Switch to worktree" }).click();
  await vi.waitFor(() =>
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.worktreePath).toBe(
      `/trees/${name}`,
    ),
  );
}

async function selectFromBranch(name: "A" | "B", trigger = "branch-A") {
  await page.getByRole("button", { name: trigger, exact: true }).click();
  await page.getByText(`branch-${name}`, { exact: true }).hover();
  await page
    .getByRole("menuitem", {
      name: trigger.startsWith("From ") ? "Select base branch" : "Checkout",
      exact: true,
    })
    .click();
}

it("persists B selected by the branch menu after A selected by the picker, through reconciliation and remount", async () => {
  const mounted = await mount();
  try {
    await selectFromPicker("A");
    await selectFromBranch("B");
    await vi.waitFor(() =>
      expect(useComposerDraftStore.getState().getDraftThread(threadId)?.worktreePath).toBe(
        "/trees/B",
      ),
    );
    const ledger = readOwnershipLedger();
    expect(ledger.status).toBe("ready");
    if (ledger.status !== "ready") throw new Error("Ownership unavailable");
    expect(ledger.value.scopes.main?.draftsByThreadId[threadId]).toMatchObject({
      worktreePath: "/trees/B",
      branch: "branch-B",
      envMode: "worktree",
      worktreeBinding: {
        path: "/trees/B",
        identity: "1:3",
        repository: "/repo/.git",
        executionTargetId: "local",
        revision: 7,
      },
    });
    reconcileComposerFromOwnershipLedger();
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.worktreePath).toBe(
      "/trees/B",
    );
  } finally {
    await mounted.screen.unmount();
    mounted.client.clear();
  }
  resetComposerDraftStore();
  reconcileComposerFromOwnershipLedger();
  const reloaded = await mount();
  try {
    await expect.element(page.getByRole("button", { name: "Worktree: B" })).toBeVisible();
    expect(
      useComposerDraftStore.getState().getDraftThread(threadId)?.worktreeBinding?.identity,
    ).toBe("1:3");
    expect(api.git.checkout).not.toHaveBeenCalled();
    expect(api.orchestration.dispatchCommand).not.toHaveBeenCalled();
  } finally {
    await reloaded.screen.unmount();
    reloaded.client.clear();
  }
});

it.each(["replaced path", "failed refresh"])(
  "rejects %s instead of overwriting verified draft ownership",
  async (failure) => {
    const mounted = await mount();
    try {
      await selectFromPicker("A");
      const previous = useComposerDraftStore.getState().getDraftThread(threadId);
      if (failure === "failed refresh")
        api.worktrees.list.mockRejectedValue(new Error("Inventory unavailable"));
      else
        api.worktrees.list.mockImplementation(async () => {
          const changed = structuredClone(listing);
          const replacement = changed.entries.find((entry) => entry.path === "/trees/B");
          if (replacement) Object.assign(replacement, { identity: "9:9" });
          return changed;
        });
      await selectFromBranch("B");
      await vi.waitFor(() =>
        expect(toast).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            description: "Worktree changed. Refresh and select again.",
          }),
        ),
      );
      expect(useComposerDraftStore.getState().getDraftThread(threadId)).toEqual(previous);
      reconcileComposerFromOwnershipLedger();
      expect(useComposerDraftStore.getState().getDraftThread(threadId)?.worktreePath).toBe(
        "/trees/A",
      );
      expect(api.git.checkout).not.toHaveBeenCalled();
      expect(api.worktrees.select).not.toHaveBeenCalled();
    } finally {
      await mounted.screen.unmount();
      mounted.client.clear();
    }
  },
);

it("keeps deferred worktree-base selection on its existing first-send path", async () => {
  useComposerDraftStore.getState().setDraftThreadContext(threadId, { envMode: "worktree" });
  const mounted = await mount();
  try {
    await selectFromBranch("B", "From main");
    await vi.waitFor(() =>
      expect(useComposerDraftStore.getState().getDraftThread(threadId)?.branch).toBe("branch-B"),
    );
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toMatchObject({
      worktreePath: null,
      envMode: "worktree",
    });
    expect(
      useComposerDraftStore.getState().getDraftThread(threadId)?.worktreeBinding,
    ).toBeUndefined();
    expect(api.git.checkout).not.toHaveBeenCalled();
    expect(api.worktrees.select).not.toHaveBeenCalled();
  } finally {
    await mounted.screen.unmount();
    mounted.client.clear();
  }
});

it("uses safe server selection when a saved chat reuses an existing branch worktree", async () => {
  useStore.setState({
    threads: [
      makeThread({ id: threadId, projectId, worktreePath: "/trees/A", branch: "branch-A" }),
    ],
  });
  const mounted = await mount();
  try {
    await selectFromBranch("B");
    await vi.waitFor(() =>
      expect(api.worktrees.select).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/repo",
          threadId,
          expectedPath: "/trees/A",
          path: "/trees/B",
          expectedIdentity: "1:3",
        }),
      ),
    );
    expect(api.git.checkout).not.toHaveBeenCalled();
    expect(api.orchestration.dispatchCommand).not.toHaveBeenCalled();
  } finally {
    await mounted.screen.unmount();
    mounted.client.clear();
  }
});

it("checks the project and reports a broken association even when its old checkout is no longer a Git repo", async () => {
  api.worktrees.list.mockResolvedValue({
    ...listing,
    linkedCount: 0,
    entries: [listing.entries[0]],
    issues: ["Chat retained: workspace is missing; history was not changed."],
  });
  const mounted = await mount(false);
  try {
    await expect.element(page.getByRole("alert")).toHaveTextContent("workspace is missing");
    await expect.element(page.getByRole("button", { name: /^Worktree:/ })).not.toBeInTheDocument();
    expect(api.worktrees.list).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo" }));
    expect(api.worktrees.select).not.toHaveBeenCalled();
  } finally {
    await mounted.screen.unmount();
    mounted.client.clear();
  }
});
