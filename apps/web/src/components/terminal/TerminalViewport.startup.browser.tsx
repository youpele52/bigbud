import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { TerminalStartupHarness } from "./TerminalViewport.startup.harness";
import { forgetTerminalLaunch } from "../../lib/terminalLaunchBinding";

const mocks = vi.hoisted(() => ({
  ready: null as null | Promise<void>,
  ensureOwner: vi.fn(),
  open: vi.fn(),
  write: vi.fn(async () => undefined),
  resize: vi.fn(async () => undefined),
  addToast: vi.fn((_options: { description?: string }) => "toast"),
  updateToast: vi.fn(),
  closeToast: vi.fn(),
}));
vi.mock("../../lib/threadMaterialization", () => ({
  ensureThreadMaterialized: (id: string) => {
    mocks.ensureOwner(id);
    return mocks.ready;
  },
}));
vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => ({ terminal: mocks }) }));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    terminalFontFamily: "system-monospace",
    terminalGpuAcceleration: "off",
  }),
}));
vi.mock("../ui/toast.manager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/toast.manager")>()),
  toastManager: { add: mocks.addToast, update: mocks.updateToast, close: mocks.closeToast },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.open.mockImplementation(
    async (input: {
      threadId: string;
      terminalId: string;
      cwd: string;
      executionTargetId?: string;
    }) => ({
      ...input,
      dropPathMode: "posix",
      worktreePath: input.cwd,
      status: "running",
      pid: 1,
      history: "origin output\r\n",
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-10-11T00:00:00.000Z",
    }),
  );
});
afterEach(() => {
  for (const id of ["bottom", "right-panel"]) forgetTerminalLaunch("draft-startup-browser", id);
});

it("awaits durable ownership for bottom and right terminals before first send, then preserves both through workspace mutation", async () => {
  let releaseOwner!: () => void;
  mocks.ready = new Promise<void>((resolve) => {
    releaseOwner = resolve;
  });
  const screen = await render(
    <TerminalStartupHarness cwd="/creation-worktree" executionTargetId="ssh:creation-target" />,
  );
  try {
    await expect.poll(() => mocks.ensureOwner.mock.calls.length).toBe(2);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(
      mocks.addToast.mock.calls.some(
        ([input]) => input.description === "Resolving terminal folder...",
      ),
    ).toBe(true);
    releaseOwner();
    await expect.poll(() => mocks.open.mock.calls.length).toBe(2);
    expect(
      mocks.open.mock.calls
        .map(([input]) => [input.terminalId, input.cwd, input.executionTargetId])
        .toSorted(),
    ).toEqual([
      ["bottom", "/creation-worktree", "ssh:creation-target"],
      ["right-panel", "/creation-worktree", "ssh:creation-target"],
    ]);
    const emulators = Array.from(screen.container.querySelectorAll(".xterm"));
    await screen.rerender(
      <TerminalStartupHarness cwd="/first-send-new-worktree" executionTargetId="local" />,
    );
    expect(Array.from(screen.container.querySelectorAll(".xterm"))).toEqual(emulators);
    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(mocks.write).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});
