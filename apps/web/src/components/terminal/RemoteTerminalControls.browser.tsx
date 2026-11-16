import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import "../../index.css";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { RemoteTerminalControls } from "./RemoteTerminalControls";

const mocks = vi.hoisted(() => {
  const target = "ssh:host=remote&transport=agent";
  return {
    target,
    launch: { runtimeGeneration: "generation", executionTargetId: target, cwd: "/work" },
    inventory: vi.fn(),
    attach: vi.fn(),
    detach: vi.fn(),
    stop: vi.fn(),
    close: vi.fn(),
    closePanel: vi.fn(),
    ensure: vi.fn(),
    hydrate: vi.fn(),
    record: vi.fn(),
  };
});
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({
    terminal: {
      remoteInventory: mocks.inventory,
      remoteAttach: mocks.attach,
      remoteDetach: mocks.detach,
      remoteStop: mocks.stop,
    },
  }),
}));
vi.mock("../../stores/main", () => ({
  useThreadById: () => undefined,
  useProjectById: () => undefined,
}));
vi.mock("../../stores/composer", () => ({ useComposerDraftStore: () => undefined }));
vi.mock("../../stores/terminal", () => ({
  useTerminalStateStore: {
    getState: () => ({
      closeTerminal: mocks.close,
      closePanelTerminal: mocks.closePanel,
      hydrateTerminalAgentFromSnapshot: mocks.hydrate,
      ensureTerminal: mocks.ensure,
    }),
  },
}));
vi.mock("../../lib/terminalLaunchBinding", () => ({
  readTerminalLaunch: () => mocks.launch,
  forgetTerminalLaunch: vi.fn(),
  subscribeTerminalLaunch: () => () => {},
  recordTerminalLaunch: mocks.record,
}));
vi.mock("./useThreadTerminalDrawer", () => ({
  resolveTerminalExecutionTargetId: () => mocks.target,
}));

let mounted: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.launch = { runtimeGeneration: "generation", executionTargetId: mocks.target, cwd: "/work" };
  mocks.inventory.mockResolvedValue({
    sessions: [
      {
        threadId: "thread",
        terminalId: "terminal",
        executionTargetId: mocks.target,
        resourceId: "pty",
        generation: "runtime",
        epoch: "epoch",
        cwd: "/work",
        status: "running",
      },
    ],
    nextCursor: "",
  });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

async function open() {
  mounted = await render(
    <RemoteTerminalControls threadId={ThreadId.makeUnsafe("thread")} terminalId="terminal" />,
  );
  await page.getByRole("button", { name: "Persistent remote terminals" }).click();
  await expect.element(page.getByRole("button", { name: "Detach current" })).toBeEnabled();
}

it("keeps the pane until Detach is acknowledged, then removes it without Stop", async () => {
  let done!: () => void;
  mocks.detach.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        done = resolve;
      }),
  );
  await open();
  await page.getByRole("button", { name: "Detach current" }).click();
  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.stop).not.toHaveBeenCalled();
  expect(mocks.detach).toHaveBeenCalledWith({
    threadId: "thread",
    terminalId: "terminal",
    expectedGeneration: "generation",
  });
  done();
  await expect.poll(() => mocks.close.mock.calls.length).toBe(1);
  expect(mocks.close).toHaveBeenCalledWith("thread", "terminal");
  expect(mocks.stop).not.toHaveBeenCalled();
});

it("keeps an uncertain detach visible and reports the error", async () => {
  mocks.detach.mockRejectedValue(new Error("Detach could not be confirmed."));
  await open();
  await page.getByRole("button", { name: "Detach current" }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("could not be confirmed");
  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.stop).not.toHaveBeenCalled();
});

it("does not remove a replaced pane when an old detach reply arrives", async () => {
  let done!: () => void;
  mocks.detach.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        done = resolve;
      }),
  );
  await open();
  await page.getByRole("button", { name: "Detach current" }).click();
  mocks.launch = { ...mocks.launch, runtimeGeneration: "replacement" };
  done();
  await expect.element(page.getByRole("button", { name: "Detach current" })).toBeEnabled();
  expect(mocks.close).not.toHaveBeenCalled();
});

it("attaches only the discovered resource and restores its pane after confirmation", async () => {
  mocks.attach.mockResolvedValue({
    threadId: "thread",
    terminalId: "terminal",
    runtimeGeneration: "restored",
  });
  await open();
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  await expect.poll(() => mocks.ensure.mock.calls.length).toBe(1);
  expect(mocks.attach).toHaveBeenCalledWith({
    threadId: "thread",
    terminalId: "terminal",
    executionTargetId: mocks.target,
    resourceId: "pty",
    cwd: "/work",
  });
  expect(mocks.record).toHaveBeenCalledOnce();
  expect(mocks.stop).not.toHaveBeenCalled();
});
