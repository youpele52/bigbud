import { ThreadId } from "@bigbud/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Thread } from "../models/types";
import { makeThread } from "../stores/main/main.store.test.helpers";

const mockState = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  dispatchCommand: vi.fn(async () => undefined),
  navigate: vi.fn(async () => undefined),
  routeThreadId: "thread-1",
  threads: [] as Thread[],
  useMutation: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockState.navigate,
  useParams: ({ select }: { select: (params: { threadId: string }) => unknown }) =>
    select({ threadId: mockState.routeThreadId }),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: mockState.useMutation,
}));

vi.mock("../rpc/nativeApi", () => ({
  readNativeApi: () => ({
    dialogs: { confirm: mockState.confirm },
    orchestration: { dispatchCommand: mockState.dispatchCommand },
  }),
}));

vi.mock("../stores/main", () => ({
  useStore: {
    getState: () => ({ threads: mockState.threads }),
  },
}));

vi.mock("./useSettings", () => ({
  useSettings: () => ({ sidebarThreadSortOrder: "created_at" }),
}));

vi.mock("./useHandleNewThread", () => ({
  useHandleNewThread: () => ({ handleNewThread: vi.fn() }),
}));

vi.mock("../lib/utils", () => ({
  newCommandId: () => "command-1",
  newThreadId: () => ThreadId.makeUnsafe("new-thread"),
}));

import { buildBranchThreadTitle, useThreadActions } from "./useThreadActions";

describe("buildBranchThreadTitle", () => {
  it("adds A for the first branch of an unsuffixed title", () => {
    expect(buildBranchThreadTitle("Old thread name", ["Old thread name"])).toBe(
      "Old thread name (A)",
    );
  });

  it("advances to the next suffix when branching an already suffixed thread", () => {
    expect(
      buildBranchThreadTitle("Old thread name (A)", ["Old thread name", "Old thread name (A)"]),
    ).toBe("Old thread name (B)");
  });

  it("uses the highest existing sibling suffix for the shared base title", () => {
    expect(
      buildBranchThreadTitle("Old thread name (A)", [
        "Old thread name",
        "Old thread name (A)",
        "Old thread name (C)",
      ]),
    ).toBe("Old thread name (D)");
  });

  it("continues past Z with spreadsheet-style suffixes", () => {
    expect(
      buildBranchThreadTitle("Old thread name (Z)", ["Old thread name", "Old thread name (Z)"]),
    ).toBe("Old thread name (AA)");
  });
});

describe("useThreadActions", () => {
  beforeEach(() => {
    mockState.confirm.mockClear();
    mockState.dispatchCommand.mockClear();
    mockState.navigate.mockClear();
    mockState.routeThreadId = "thread-1";
    mockState.useMutation.mockClear();
    mockState.threads = [
      makeThread({
        id: ThreadId.makeUnsafe("thread-1"),
        createdAt: "2026-03-09T10:00:00.000Z",
        worktreePath: "/repo/worktrees/thread-1",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-2"),
        createdAt: "2026-03-09T10:05:00.000Z",
      }),
    ];
  });

  it("dispatches deletion and navigates to the fallback thread", async () => {
    let actions: ReturnType<typeof useThreadActions> | undefined;

    function ThreadActionsCapture() {
      actions = useThreadActions();
      return null;
    }

    renderToStaticMarkup(createElement(ThreadActionsCapture));

    await actions!.deleteThread(ThreadId.makeUnsafe("thread-1"));

    expect(mockState.dispatchCommand).toHaveBeenCalledWith({
      type: "thread.delete",
      commandId: "command-1",
      threadId: ThreadId.makeUnsafe("thread-1"),
    });
    expect(mockState.navigate).toHaveBeenCalledWith({
      to: "/$threadId",
      params: { threadId: ThreadId.makeUnsafe("thread-2") },
      replace: true,
    });
    expect(mockState.confirm).not.toHaveBeenCalled();
    expect(mockState.useMutation).not.toHaveBeenCalled();
  });
});
