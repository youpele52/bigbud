import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { MetadataGenerationWarning } from "@bigbud/contracts/orchestration/orchestration.metadataGeneration.ts";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

interface TestToast {
  readonly type?: string;
  readonly title?: string;
  readonly description?: string;
  readonly actionProps?: { readonly children?: string; readonly onClick?: () => void };
}

const mocks = vi.hoisted(() => ({
  warnings: [] as MetadataGenerationWarning[],
  navigate: vi.fn(),
  add: vi.fn((_toast: TestToast) => "metadata-warning"),
  claim: vi.fn(async () => mocks.warnings),
  acknowledge: vi.fn(async () => true),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../rpc/wsConnectionState", () => ({
  useWsConnectionStatus: () => ({ phase: "connected", connectedAt: 1 }),
}));
vi.mock("../rpc/nativeApi", () => ({
  readNativeApi: () => ({
    server: { claimMetadataWarnings: mocks.claim, acknowledgeMetadataWarning: mocks.acknowledge },
  }),
}));
vi.mock("./ui/toast", () => ({ toastManager: { add: mocks.add } }));

import { MetadataWarningToastCoordinator } from "./MetadataWarningToastCoordinator";
import { useThreadRenameRequest } from "./sidebar/Sidebar.threadRenameRequest";

afterEach(() => {
  mocks.warnings = [];
  useThreadRenameRequest.setState({ threadId: null });
  mocks.navigate.mockReset();
  mocks.add.mockClear();
  mocks.claim.mockClear();
  mocks.acknowledge.mockClear();
  document.body.innerHTML = "";
});

it.each([0, 1, 2, 3])(
  "shows a warning with %s actual failures and links directly to AI settings",
  async (primaryFailures) => {
    mocks.warnings = [
      {
        id: `warning-${primaryFailures}`,
        configEpoch: "epoch-1",
        threadId: ThreadId.makeUnsafe("thread-1"),
        operation: "summary",
        createdAt: "2026-11-09T00:00:00.000Z",
        primaryFailures,
      },
    ];
    mocks.acknowledge.mockImplementation(async () => {
      expect(mocks.add).toHaveBeenCalledTimes(1);
      return true;
    });
    await render(<MetadataWarningToastCoordinator />);
    await vi.waitFor(() => expect(mocks.acknowledge).toHaveBeenCalledTimes(1));
    const toast = mocks.add.mock.calls[0]![0];
    expect(toast.type).toBe("warning");
    expect(toast.description?.includes("exhausted its attempts")).toBe(primaryFailures >= 2);
    expect(toast.description).not.toContain("three attempts");
    expect(toast.actionProps?.children).toBe("Review AI settings");
    toast.actionProps?.onClick?.();
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/settings/ai",
      hash: "text-generation-model",
    });
  },
);

it.each(["title", "summary"] as const)(
  "delivers the final %s warning and only its recovery action",
  async (operation) => {
    const threadId = ThreadId.makeUnsafe("failed-thread");
    mocks.warnings = [
      {
        id: `final-${operation}`,
        configEpoch: `metadata-final:${operation}:${threadId}`,
        threadId,
        operation,
        kind: "final",
        primaryFailures: 2,
        createdAt: "2026-11-10T00:00:00.000Z",
      },
    ];
    await render(<MetadataWarningToastCoordinator />);
    await vi.waitFor(() => expect(mocks.acknowledge).toHaveBeenCalledOnce());
    const toast = mocks.add.mock.calls[0]![0];
    expect(toast.type).toBe("warning");
    expect(toast.description).toBeUndefined();
    expect(toast.title).toBe(
      operation === "title"
        ? "This thread couldn't be named automatically. Rename it, or ask the agent in the thread to do it."
        : "This thread's summary couldn't be created automatically. Ask the agent in the thread to write one.",
    );
    if (operation === "title") {
      expect(toast.actionProps?.children).toBe("Rename");
      toast.actionProps?.onClick?.();
      expect(useThreadRenameRequest.getState().threadId).toBe(threadId);
    } else {
      expect(toast.actionProps).toBeUndefined();
      expect(useThreadRenameRequest.getState().threadId).toBeNull();
    }
    expect(mocks.navigate).not.toHaveBeenCalled();
  },
);
