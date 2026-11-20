import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { BUILT_IN_CHATS_PROJECT_ID } from "@bigbud/contracts/constants/project.constant";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import type { SidebarThreadSummary } from "../../models/types";

const mocks = vi.hoisted(() => ({
  routeThreadId: undefined as string | undefined,
  isMobile: false,
  setOpen: vi.fn(),
  setOpenMobile: vi.fn(),
  navigate: vi.fn(),
  accessCheck: vi.fn<(input: { onVerified: () => void | Promise<void> }) => Promise<boolean>>(),
  setChatsExpanded: vi.fn(),
  setProjectsExpanded: vi.fn(),
  setRemoteWorkspacesExpanded: vi.fn(),
  setProjectExpanded: vi.fn(),
  setStateCollapsed: vi.fn(),
  cancelProjectRename: vi.fn(),
  dispatch: vi.fn(async () => {}),
}));
vi.mock("@tanstack/react-router", () => ({ useParams: () => ({ threadId: mocks.routeThreadId }) }));
vi.mock("../ui/sidebar", () => ({
  useSidebar: () => ({
    isMobile: mocks.isMobile,
    setOpen: mocks.setOpen,
    setOpenMobile: mocks.setOpenMobile,
  }),
}));
vi.mock("../../stores/ui", () => ({ useUiStateStore: { getState: () => mocks } }));
vi.mock("../../stores/inyosira/inyosira.store", () => ({
  useInyosiraStore: { getState: () => mocks },
}));
vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => ({}) }));
vi.mock("../../lib/orchestrationCommandRecovery", () => ({
  dispatchCommandWithOutcomeRecovery: mocks.dispatch,
}));

vi.mock("../../hooks/useRemoteExecutionAccessGate", () => ({
  useRemoteExecutionAccessGate: () => ({
    beginRemoteExecutionTargetAccessCheck: mocks.accessCheck,
  }),
}));

import { useSidebarThreadRenameActions } from "./Sidebar.threadActions.rename";
import { useSidebarRemoteThreadActivation } from "./Sidebar.remoteThreadActivation";
import {
  THREAD_RENAME_REQUEST_TTL_MS,
  useThreadRenameRequest,
} from "./Sidebar.threadRenameRequest";

const thread: SidebarThreadSummary = {
  id: ThreadId.makeUnsafe("rename-target"),
  projectId: ProjectId.makeUnsafe("project"),
  title: "New thread",
  interactionMode: "default",
  session: null,
  createdAt: "2026-11-10T00:00:00.000Z",
  archivedAt: null,
  pinnedAt: null,
  latestTurn: null,
  branch: null,
  worktreePath: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};
function Harness({ target = thread }: { target?: SidebarThreadSummary | null }) {
  const sidebarThreadsById = target ? { [target.id]: target } : {};
  const activation = useSidebarRemoteThreadActivation({
    sidebarThreadsById,
    projectCwdById: new Map(),
    navigateToThreadRoute: mocks.navigate,
  });
  const rename = useSidebarThreadRenameActions({
    sidebarThreadsById,
    navigateToThreadRoute: activation.navigateToThread,
    cancelProjectRename: mocks.cancelProjectRename,
  });
  return rename.renamingThreadId ? (
    <input
      aria-label="Rename thread"
      ref={rename.onRenamingInputMount}
      value={rename.renamingTitle}
      onChange={(event) => rename.setRenamingTitle(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter")
          void rename.commitRename(thread.id, rename.renamingTitle, thread.title);
      }}
    />
  ) : null;
}
afterEach(() => {
  useThreadRenameRequest.setState({ threadId: null });
  mocks.routeThreadId = undefined;
  mocks.isMobile = false;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.navigate.mockReset();
  mocks.accessCheck.mockReset();
});

it.each([false, true])(
  "waits for gated navigation, reveals and focuses existing rename UI (mobile=%s)",
  async (mobile) => {
    mocks.isMobile = mobile;
    useThreadRenameRequest.getState().request(thread.id);
    const screen = await render(<Harness />);
    await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(thread.id));
    expect(document.querySelector("input")).toBeNull();
    expect(mocks.setOpen).not.toHaveBeenCalled();
    mocks.routeThreadId = thread.id;
    await screen.rerender(<Harness />);
    await vi.waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Rename thread"),
    );
    const input = document.activeElement as HTMLInputElement;
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(thread.title.length);
    expect(mobile ? mocks.setOpenMobile : mocks.setOpen).toHaveBeenCalledWith(true);
    expect(mocks.setProjectExpanded).toHaveBeenCalledWith(thread.projectId, true);
    expect(mocks.setStateCollapsed).toHaveBeenCalledWith("present", false);
    expect(useThreadRenameRequest.getState().threadId).toBeNull();
    await screen.getByRole("textbox", { name: "Rename thread" }).fill("  Manual title  ");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledOnce());
    expect(mocks.dispatch.mock.calls[0]).toEqual([
      {},
      expect.objectContaining({
        type: "thread.meta.update",
        threadId: thread.id,
        title: "Manual title",
      }),
    ]);
  },
);

it("waits for a missing summary and expands Chats instead of project sections", async () => {
  useThreadRenameRequest.getState().request(thread.id);
  const screen = await render(<Harness target={null} />);
  expect(mocks.navigate).not.toHaveBeenCalled();
  mocks.routeThreadId = thread.id;
  await screen.rerender(<Harness target={{ ...thread, projectId: BUILT_IN_CHATS_PROJECT_ID }} />);
  await vi.waitFor(() => expect(mocks.setChatsExpanded).toHaveBeenCalledWith(true));
  expect(mocks.setProjectExpanded).not.toHaveBeenCalled();
});

it.each(["archivedAt", "deletingAt"] as const)(
  "discards requests for %s threads",
  async (field) => {
    useThreadRenameRequest.getState().request(thread.id);
    await render(<Harness target={{ ...thread, [field]: thread.createdAt }} />);
    await vi.waitFor(() => expect(useThreadRenameRequest.getState().threadId).toBeNull());
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(document.querySelector("input")).toBeNull();
  },
);

it.each(["refusal", "rejection", "throw"] as const)(
  "clears remote access %s so a later route cannot open Rename",
  async (outcome) => {
    const remote = {
      ...thread,
      workspaceExecutionTargetId: "ssh:host=test&user=test&port=22&auth=ssh-key",
    };
    if (outcome === "refusal") mocks.accessCheck.mockResolvedValue(false);
    else if (outcome === "rejection")
      mocks.accessCheck.mockRejectedValue(new Error("Access failed"));
    else
      mocks.accessCheck.mockImplementation(() => {
        throw new Error("Access failed");
      });
    useThreadRenameRequest.getState().request(thread.id);
    const screen = await render(<Harness target={remote} />);
    await vi.waitFor(() => expect(useThreadRenameRequest.getState().threadId).toBeNull());
    expect(mocks.accessCheck).toHaveBeenCalledOnce();
    expect(mocks.navigate).not.toHaveBeenCalled();
    mocks.routeThreadId = thread.id;
    await screen.rerender(<Harness target={remote} />);
    expect(document.querySelector("input")).toBeNull();
  },
);

it.each(["missing-target", "pending-navigation"] as const)(
  "expires %s and never opens Rename on a late route",
  async (reason) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    useThreadRenameRequest.getState().request(thread.id);
    const screen = await render(<Harness target={reason === "missing-target" ? null : thread} />);
    await vi.advanceTimersByTimeAsync(THREAD_RENAME_REQUEST_TTL_MS);
    expect(useThreadRenameRequest.getState().threadId).toBeNull();
    mocks.routeThreadId = thread.id;
    await screen.rerender(<Harness />);
    expect(document.querySelector("input")).toBeNull();
  },
);

it("keeps valid navigation across a sidebar remount without extending its deadline", async () => {
  mocks.accessCheck.mockImplementation(async ({ onVerified }) => {
    await onVerified();
    return true;
  });
  const remote = {
    ...thread,
    workspaceExecutionTargetId: "ssh:host=test&user=test&port=22&auth=ssh-key",
  };
  useThreadRenameRequest.getState().request(thread.id);
  const expiresAt = useThreadRenameRequest.getState().expiresAt;
  const first = await render(<Harness target={remote} />);
  await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(thread.id));
  expect(document.querySelector("input")).toBeNull();
  await first.unmount();
  mocks.routeThreadId = thread.id;
  const second = await render(<Harness target={remote} />);
  await expect.element(second.getByRole("textbox", { name: "Rename thread" })).toBeVisible();
  expect(useThreadRenameRequest.getState().threadId).toBeNull();
  expect(useThreadRenameRequest.getState().expiresAt).toBe(expiresAt);
  expect(mocks.accessCheck).toHaveBeenCalledOnce();
});

it("does not let a stale remote refusal clear a newer same-thread request", async () => {
  let refuse!: (accepted: boolean) => void;
  mocks.accessCheck.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        refuse = resolve;
      }),
  );
  const remote = {
    ...thread,
    workspaceExecutionTargetId: "ssh:host=test&user=test&port=22&auth=ssh-key",
  };
  useThreadRenameRequest.getState().request(thread.id);
  const first = await render(<Harness target={remote} />);
  await vi.waitFor(() => expect(mocks.accessCheck).toHaveBeenCalledOnce());
  await first.unmount();
  useThreadRenameRequest.getState().request(thread.id);
  const requestId = useThreadRenameRequest.getState().requestId;
  refuse(false);
  await Promise.resolve();
  expect(useThreadRenameRequest.getState().threadId).toBe(thread.id);
  expect(useThreadRenameRequest.getState().requestId).toBe(requestId);
  mocks.routeThreadId = thread.id;
  const second = await render(<Harness />);
  await expect.element(second.getByRole("textbox", { name: "Rename thread" })).toBeVisible();
});

it("rejects expired wall-clock requests even if the expiration timer was throttled", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  useThreadRenameRequest.getState().request(thread.id);
  const expiresAt = useThreadRenameRequest.getState().expiresAt;
  const screen = await render(<Harness target={null} />);
  vi.setSystemTime(expiresAt);
  mocks.routeThreadId = thread.id;
  await screen.rerender(<Harness />);
  expect(useThreadRenameRequest.getState().threadId).toBeNull();
  expect(document.querySelector("input")).toBeNull();
});
