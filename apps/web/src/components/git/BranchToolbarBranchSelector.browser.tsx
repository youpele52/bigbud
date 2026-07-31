import "../../index.css";

import type { GitBranch } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const TEST_BRANCHES: ReadonlyArray<GitBranch> = Array.from({ length: 120 }, (_, index) => ({
  name: index === 0 ? "main" : `feature/branch-${String(index).padStart(3, "0")}`,
  current: index === 0,
  isDefault: index === 0,
  worktreePath: null,
  ...(index === 42
    ? {
        webLink: {
          provider: "github" as const,
          repositoryUrl: "https://github.com/acme/project",
          branchUrl: "https://github.com/acme/project/tree/feature%2Fbranch-042",
        },
      }
    : index === 43
      ? {
          webLink: {
            provider: "gitlab" as const,
            repositoryUrl: "https://gitlab.com/acme/platform/project",
            branchUrl: "https://gitlab.com/acme/platform/project/-/tree/feature%2Fbranch-043",
          },
        }
      : {}),
}));

const {
  apiRef,
  checkoutSpy,
  deleteBranchSpy,
  invalidateQueriesSpy,
  onSetThreadBranchSpy,
  openExternalSpy,
  prefetchInfiniteQuerySpy,
  renameBranchSpy,
  toastAddSpy,
} = vi.hoisted(() => {
  const checkout = vi.fn(() => Promise.resolve({ branch: "feature/branch-042" }));
  const createBranch = vi.fn(() => Promise.resolve({ branch: "feature/new" }));
  const deleteBranch = vi.fn(() => Promise.resolve());
  const refreshStatus = vi.fn(() => Promise.resolve({ branch: "feature/branch-042" }));
  const renameBranch = vi.fn(() => Promise.resolve({ branch: "feature/renamed" }));
  const openExternal = vi.fn(() => Promise.resolve());
  return {
    apiRef: {
      current: {
        git: {
          checkout,
          createBranch,
          deleteBranch,
          refreshStatus,
          renameBranch,
          listBranches: vi.fn(),
        },
        shell: { openExternal },
      },
    },
    checkoutSpy: checkout,
    deleteBranchSpy: deleteBranch,
    invalidateQueriesSpy: vi.fn(() => Promise.resolve()),
    onSetThreadBranchSpy: vi.fn(),
    openExternalSpy: openExternal,
    prefetchInfiniteQuerySpy: vi.fn(() => Promise.resolve()),
    renameBranchSpy: renameBranch,
    toastAddSpy: vi.fn(),
  };
});

vi.mock("@tanstack/react-query", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQuery: vi.fn(() => ({ data: { branch: "main" } })),
    useInfiniteQuery: vi.fn(() => ({
      data: {
        pages: [
          {
            branches: TEST_BRANCHES,
            isRepo: true,
            hasOriginRemote: true,
            nextCursor: null,
            totalCount: TEST_BRANCHES.length,
          },
        ],
      },
      fetchNextPage: vi.fn(() => Promise.resolve()),
      hasNextPage: false,
      isFetchingNextPage: false,
      isPending: false,
    })),
    useQueryClient: vi.fn(() => ({
      invalidateQueries: invalidateQueriesSpy,
      prefetchInfiniteQuery: prefetchInfiniteQuerySpy,
    })),
  };
});

vi.mock("../../rpc/nativeApi", () => ({
  ensureNativeApi: vi.fn(() => apiRef.current),
  readNativeApi: vi.fn(() => apiRef.current),
}));

vi.mock("../ui/toast", () => ({ toastManager: { add: toastAddSpy } }));

import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";

function findButtonByText(text: string): HTMLButtonElement | null {
  return (Array.from(document.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text),
  ) ?? null) as HTMLButtonElement | null;
}

async function renderSelector() {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <BranchToolbarBranchSelector
      activeProjectCwd="/repo/project"
      activeThreadBranch="main"
      activeWorktreePath={null}
      branchCwd="/repo/project"
      effectiveEnvMode="local"
      envLocked={false}
      onSetThreadBranch={onSetThreadBranchSpy}
    />,
    { container: host },
  );
  return { host, screen };
}

async function openBranchMenu() {
  await vi.waitFor(() => expect(findButtonByText("main")).toBeTruthy());
  findButtonByText("main")?.click();
  await expect.element(page.getByText("feature/branch-042")).toBeInTheDocument();
}

async function openBranchSubmenu(branchName = "feature/branch-042") {
  await openBranchMenu();
  await page.getByText(branchName).hover();
  await expect.element(page.getByText("Copy branch name")).toBeInTheDocument();
}

describe("BranchToolbarBranchSelector", () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("opens from the branch trigger and renders branches as submenu triggers", async () => {
    const { host, screen } = await renderSelector();
    try {
      await openBranchMenu();
      const branch = Array.from(document.querySelectorAll('[data-slot="menu-sub-trigger"]')).find(
        (element) => element.textContent?.includes("feature/branch-042"),
      );
      expect(branch).toBeTruthy();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("opens a branch submenu on hover without checking out", async () => {
    const { host, screen } = await renderSelector();
    try {
      await openBranchSubmenu();
      const checkoutItem = Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find(
        (element) => element.textContent?.trim() === "Checkout",
      );
      expect(checkoutItem).toBeTruthy();
      expect(getComputedStyle(checkoutItem!).fontSize).toBe("14px");
      expect(checkoutSpy).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("opens exact GitHub and GitLab branch URLs", async () => {
    const { host, screen } = await renderSelector();
    try {
      await openBranchSubmenu("feature/branch-042");
      await page.getByText("View on GitHub", { exact: true }).click();
      expect(openExternalSpy).toHaveBeenLastCalledWith(
        "https://github.com/acme/project/tree/feature%2Fbranch-042",
      );

      await openBranchSubmenu("feature/branch-043");
      const gitlabLink = page.getByText("View on GitLab", { exact: true });
      expect(getComputedStyle(gitlabLink.element()).fontSize).toBe("14px");
      await gitlabLink.click();
      expect(openExternalSpy).toHaveBeenLastCalledWith(
        "https://gitlab.com/acme/platform/project/-/tree/feature%2Fbranch-043",
      );
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("shows a toast when opening a branch link fails", async () => {
    const { host, screen } = await renderSelector();
    try {
      openExternalSpy.mockRejectedValueOnce(new Error("Opening was blocked."));
      await openBranchSubmenu("feature/branch-042");
      await page.getByText("View on GitHub", { exact: true }).click();

      await vi.waitFor(() => {
        expect(toastAddSpy).toHaveBeenCalledWith({
          type: "error",
          title: "Failed to open link.",
          description: "Opening was blocked.",
        });
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("checks out a branch from its primary submenu action", async () => {
    const { host, screen } = await renderSelector();
    try {
      await openBranchSubmenu();
      await page.getByText("Checkout", { exact: true }).click();
      await vi.waitFor(() => {
        expect(checkoutSpy).toHaveBeenCalledWith({
          cwd: "/repo/project",
          branch: "feature/branch-042",
        });
        expect(onSetThreadBranchSpy).toHaveBeenCalledWith("feature/branch-042", null);
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps the rename dialog mounted after menu closure and submits the new name", async () => {
    const { host, screen } = await renderSelector();
    try {
      await openBranchSubmenu();
      await page.getByText("Rename", { exact: true }).click();
      const input = page.getByRole("textbox", { name: "New branch name" });
      await expect.element(input).toHaveValue("feature/branch-042");
      await input.fill("feature/renamed");
      await page.getByRole("button", { name: "Rename branch" }).click();
      await vi.waitFor(() => {
        expect(renameBranchSpy).toHaveBeenCalledWith({
          cwd: "/repo/project",
          oldBranch: "feature/branch-042",
          newBranch: "feature/renamed",
        });
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps mandatory delete confirmation mounted and cancel does not delete", async () => {
    const { host, screen } = await renderSelector();
    try {
      await openBranchSubmenu();
      await page.getByText("Delete", { exact: true }).click();
      await expect
        .element(page.getByText('Delete branch "feature/branch-042"?'))
        .toBeInTheDocument();
      await page.getByRole("button", { name: "Cancel" }).click();
      expect(deleteBranchSpy).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
