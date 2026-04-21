import "../../index.css";

import type { GitBranch } from "@bigbud/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const TEST_BRANCHES: ReadonlyArray<GitBranch> = Array.from({ length: 120 }, (_, index) => ({
  name: index === 0 ? "main" : `feature/branch-${String(index).padStart(3, "0")}`,
  current: index === 0,
  isDefault: index === 0,
  worktreePath: null,
}));

const {
  apiRef,
  checkoutSpy,
  createBranchSpy,
  invalidateQueriesSpy,
  onSetThreadBranchSpy,
  prefetchInfiniteQuerySpy,
  refreshStatusSpy,
  toastAddSpy,
} = vi.hoisted(() => ({
  apiRef: {
    current: {
      git: {
        checkout: vi.fn(() => Promise.resolve({ branch: "feature/branch-042" })),
        createBranch: vi.fn(() => Promise.resolve({ branch: "feature/new" })),
        refreshStatus: vi.fn(() => Promise.resolve({ branch: "feature/branch-042" })),
        listBranches: vi.fn(),
      },
    },
  },
  checkoutSpy: vi.fn(() => Promise.resolve({ branch: "feature/branch-042" })),
  createBranchSpy: vi.fn(() => Promise.resolve({ branch: "feature/new" })),
  invalidateQueriesSpy: vi.fn(() => Promise.resolve()),
  onSetThreadBranchSpy: vi.fn(),
  prefetchInfiniteQuerySpy: vi.fn(() => Promise.resolve()),
  refreshStatusSpy: vi.fn(() => Promise.resolve({ branch: "feature/branch-042" })),
  toastAddSpy: vi.fn(),
}));

apiRef.current.git.checkout = checkoutSpy;
apiRef.current.git.createBranch = createBranchSpy;
apiRef.current.git.refreshStatus = refreshStatusSpy;

vi.mock("@tanstack/react-query", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");

  return {
    ...actual,
    useQuery: vi.fn(() => ({
      data: {
        branch: "main",
      },
    })),
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

vi.mock("../ui/toast", () => ({
  toastManager: {
    add: toastAddSpy,
  },
}));

import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";

function findButtonByText(text: string): HTMLButtonElement | null {
  return (Array.from(document.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text),
  ) ?? null) as HTMLButtonElement | null;
}

describe("BranchToolbarBranchSelector", () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("renders large branch lists and checks out the selected branch", async () => {
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

    try {
      await vi.waitFor(() => {
        expect(findButtonByText("main")).toBeTruthy();
      });

      const trigger = findButtonByText("main");
      if (!(trigger instanceof HTMLButtonElement)) {
        throw new Error("Unable to find branch selector trigger.");
      }
      trigger.click();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("feature/branch-042");
      });

      const option = Array.from(document.querySelectorAll('[data-slot="combobox-item"]')).find(
        (element) => element.textContent?.includes("feature/branch-042"),
      );
      if (!(option instanceof HTMLElement)) {
        throw new Error("Unable to find branch option.");
      }
      option.click();

      await vi.waitFor(() => {
        expect(checkoutSpy).toHaveBeenCalledWith({
          cwd: "/repo/project",
          branch: "feature/branch-042",
        });
        expect(onSetThreadBranchSpy).toHaveBeenCalledWith("feature/branch-042", null);
      });

      expect(toastAddSpy).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
