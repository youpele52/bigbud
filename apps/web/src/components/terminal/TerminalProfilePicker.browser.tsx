import "../../index.css";
import type { Terminal } from "@xterm/xterm";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { NativeApi } from "@bigbud/contracts/server/ipc.nativeApi.ts";
import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import type { TerminalShellProfileInventory } from "@bigbud/contracts/workspace/terminal.shellProfiles.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { recordTerminalLaunch, forgetTerminalLaunch } from "../../lib/terminalLaunchBinding";
import { useSearchStore } from "../../stores/ui/search.store";
import { useTerminalLifecycleStore } from "../../stores/terminal/terminalLifecycle.store";
import { toastManager } from "../ui/toast.manager";
import { TerminalProfilePicker } from "./TerminalProfilePicker";
import { registerTerminalProfileRestart } from "./TerminalProfilePicker.restart";
import { makeTerminalRestartAction } from "./TerminalViewport.restart";

const mocks = vi.hoisted(() => ({ shellProfiles: vi.fn() }));
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({ terminal: { shellProfiles: mocks.shellProfiles } }),
}));
vi.mock("../ui/toast.manager", () => ({ toastManager: { add: vi.fn() } }));
const threadId = ThreadId.makeUnsafe("profile-browser");
const host = { kind: "ssh", hostId: "ssh:browser" } as const;
const snapshot: TerminalSessionSnapshot = {
  threadId,
  terminalId: "one",
  cwd: "/remote/work",
  worktreePath: null,
  executionTargetId: "ssh:browser",
  status: "running",
  pid: 1,
  history: "",
  exitCode: null,
  exitSignal: null,
  dropPathMode: "posix",
  runtimeGeneration: "one",
  updatedAt: "2026-11-11T00:00:00Z",
  shellLaunchIdentity: {
    host,
    selection: { kind: "profile", profileId: "zsh" },
    profileId: "zsh",
    kind: "zsh",
    integration: { status: "disabled" },
  },
};
const inventory: TerminalShellProfileInventory = {
  exactProfileLaunchesEnabled: true,
  runtimeGeneration: "one",
  host,
  profiles: [
    {
      profileId: "zsh",
      displayName: "Remote Zsh",
      kind: "zsh",
      availability: "available",
      host,
      executable: "/bin/zsh",
      args: [],
      platform: "linux",
      integration: { status: "disabled" },
    },
    {
      profileId: "bash",
      displayName: "Remote Bash",
      kind: "bash",
      availability: "available",
      host,
      executable: "/bin/bash",
      args: [],
      platform: "linux",
      integration: { status: "disabled" },
    },
  ],
};
const props = () => ({ threadId, terminalId: "one", onNewTerminal: vi.fn() });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.shellProfiles.mockResolvedValue(inventory);
  useTerminalLifecycleStore.setState({ operations: {} });
  recordTerminalLaunch(snapshot);
});
afterEach(() => {
  forgetTerminalLaunch(threadId, "one");
  forgetTerminalLaunch(threadId, "two");
  useTerminalLifecycleStore.setState({ operations: {} });
});
async function open() {
  await expect
    .element(page.getByRole("button", { name: "Terminal actions" }))
    .toHaveAttribute("title", "Terminal actions");
  await page.getByRole("button", { name: "Terminal actions" }).click();
  await expect
    .element(page.getByRole("menuitem", { name: "New terminal", exact: true }))
    .toBeEnabled();
}
async function choose(action: string) {
  await page.getByRole("menuitem", { name: action, exact: true }).click();
  await page.getByRole("menuitem", { name: "Remote Bash", exact: true }).click();
}

describe("per-pane shell picker", () => {
  it("only reads current-pane inventory while browsing; safe new action never restarts the source", async () => {
    const p = props();
    const restart = vi.fn();
    const unregister = registerTerminalProfileRestart(threadId, "one", restart);
    const screen = await render(<TerminalProfilePicker {...p} />);
    try {
      await open();
      expect(mocks.shellProfiles).toHaveBeenCalledExactlyOnceWith({ threadId, terminalId: "one" });
      expect(p.onNewTerminal).not.toHaveBeenCalled();
      expect(restart).not.toHaveBeenCalled();
      await choose("New terminal");
      expect(p.onNewTerminal).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ host, shellSelection: { kind: "profile", profileId: "bash" } }),
      );
      expect(restart).not.toHaveBeenCalled();
    } finally {
      unregister();
      await screen.unmount();
    }
  });
  it("uses the mounted restart owner and cancellation makes no destructive request", async () => {
    const p = props();
    const confirm = vi.fn(async () => false);
    const restart = vi.fn();
    const prepare = vi.fn();
    const action = makeTerminalRestartAction({
      api: { dialogs: { confirm }, terminal: { restart } } as unknown as NativeApi,
      terminal: { cols: 80, rows: 24 } as Terminal,
      readSnapshot: () => snapshot,
      disposed: () => false,
      prepare,
      isCurrent: () => true,
      onSnapshot: vi.fn(),
      onFailure: vi.fn(),
    });
    const unregister = registerTerminalProfileRestart(threadId, "one", action);
    const screen = await render(<TerminalProfilePicker {...p} />);
    try {
      await open();
      await choose("Change shell");
      await expect.poll(() => confirm.mock.calls.length).toBe(1);
      expect(restart).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(p.onNewTerminal).not.toHaveBeenCalled();
    } finally {
      unregister();
      await screen.unmount();
    }
  });
  it("shows discovery errors and never substitutes local profiles", async () => {
    mocks.shellProfiles.mockRejectedValue(new Error("Remote inventory denied"));
    const p = props();
    const screen = await render(<TerminalProfilePicker {...p} />);
    await page.getByRole("button", { name: "Terminal actions" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Remote inventory denied");
    await expect
      .element(page.getByRole("menuitem", { name: "New terminal", exact: true }))
      .toBeDisabled();
    expect(p.onNewTerminal).not.toHaveBeenCalled();
    await screen.unmount();
  });
  it("keeps bridge errors visible as failure toasts after the menu closes", async () => {
    const screen = await render(<TerminalProfilePicker {...props()} />);
    await open();
    await choose("Change shell");
    await expect.poll(() => vi.mocked(toastManager.add).mock.calls.length).toBe(1);
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        description: expect.stringContaining("view is unavailable"),
      }),
    );
    await screen.unmount();
  });
  it("rejects another host's inventory without using its matching profile name", async () => {
    mocks.shellProfiles.mockResolvedValue({
      ...inventory,
      host: { kind: "ssh", hostId: "ssh:other" },
    });
    const screen = await render(<TerminalProfilePicker {...props()} />);
    await page.getByRole("button", { name: "Terminal actions" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("The terminal host changed");
    await expect.element(page.getByText("zsh · ssh", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Terminal actions" })).toBeVisible();
    await expect
      .element(page.getByRole("menuitem", { name: "New terminal", exact: true }))
      .toBeDisabled();
    await screen.unmount();
  });
  it("labels requested identity as unconfirmed, never as the actual profile", async () => {
    recordTerminalLaunch({
      ...snapshot,
      updatedAt: "2026-11-11T00:00:01Z",
      shellLaunchIdentity: undefined,
      shellUnconfirmedLaunch: {
        status: "unconfirmed",
        requestedProfile: { host, profileId: "bash", kind: "bash" },
      },
    });
    const screen = await render(<TerminalProfilePicker {...props()} />);
    await expect.element(page.getByRole("button", { name: "Terminal actions" })).toBeVisible();
    await open();
    await expect
      .element(page.getByText("Actual shell has not been confirmed.", { exact: false }))
      .toBeVisible();
    await screen.unmount();
  });
  it("invalidates a pending inventory when the active pane changes", async () => {
    let resolve!: (value: TerminalShellProfileInventory) => void;
    mocks.shellProfiles.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const p = props();
    const screen = await render(<TerminalProfilePicker {...p} />);
    await page.getByRole("button", { name: "Terminal actions" }).click();
    await expect.element(page.getByText("Loading this host's profiles…")).toBeVisible();
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("menuitem", { name: "New terminal", exact: true }))
      .toBeDisabled();
    recordTerminalLaunch({ ...snapshot, terminalId: "two", shellLaunchIdentity: undefined });
    await screen.rerender(<TerminalProfilePicker {...p} terminalId="two" />);
    resolve(inventory);
    await expect.element(page.getByRole("button", { name: "Terminal actions" })).toBeVisible();
    await expect
      .element(page.getByRole("menuitem", { name: "Remote Bash", exact: true }))
      .not.toBeInTheDocument();
    expect(p.onNewTerminal).not.toHaveBeenCalled();
    await screen.unmount();
  });
  it("selects a new profile by keyboard and restores focus without replacing the source", async () => {
    const p = props();
    const restart = vi.fn();
    const unregister = registerTerminalProfileRestart(threadId, "one", restart);
    const screen = await render(<TerminalProfilePicker {...p} />);
    try {
      const trigger = page.getByRole("button", { name: "Terminal actions" });
      (trigger.element() as HTMLElement).focus();
      await userEvent.keyboard("{Enter}");
      const submenu = page.getByRole("menuitem", { name: "New terminal", exact: true });
      await expect.element(submenu).toBeEnabled();
      (submenu.element() as HTMLElement).focus();
      await userEvent.keyboard("{ArrowRight}{ArrowDown}{Enter}");
      await expect.poll(() => p.onNewTerminal.mock.calls.length).toBe(1);
      expect(p.onNewTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          shellSelection: { kind: "profile", profileId: "bash" },
        }),
      );
      expect(restart).not.toHaveBeenCalled();
      await expect.element(trigger).toHaveFocus();
    } finally {
      unregister();
      await screen.unmount();
    }
  });

  it("cannot apply a confirmation that resolves after the active pane changed", async () => {
    let confirm!: (value: boolean) => void;
    const restart = vi.fn();
    const prepare = vi.fn();
    const action = makeTerminalRestartAction({
      api: {
        dialogs: {
          confirm: () =>
            new Promise<boolean>((resolve) => {
              confirm = resolve;
            }),
        },
        terminal: { restart },
      } as unknown as NativeApi,
      terminal: { cols: 80, rows: 24 } as Terminal,
      readSnapshot: () => snapshot,
      disposed: () => false,
      prepare,
      isCurrent: () => true,
      onSnapshot: vi.fn(),
      onFailure: vi.fn(),
    });
    const unregister = registerTerminalProfileRestart(threadId, "one", action);
    const p = props();
    const screen = await render(<TerminalProfilePicker {...p} />);
    try {
      await open();
      await choose("Change shell");
      await expect.poll(() => typeof confirm).toBe("function");
      recordTerminalLaunch({ ...snapshot, terminalId: "two" });
      await screen.rerender(<TerminalProfilePicker {...p} terminalId="two" />);
      confirm(true);
      await expect.poll(() => useTerminalLifecycleStore.getState().operations).toEqual({});
      expect(prepare).not.toHaveBeenCalled();
      expect(restart).not.toHaveBeenCalled();
      expect(p.onNewTerminal).not.toHaveBeenCalled();
    } finally {
      unregister();
      await screen.unmount();
    }
  });

  it("supports keyboard opening, Escape dismissal and returns focus to its trigger", async () => {
    const screen = await render(<TerminalProfilePicker {...props()} />);
    const trigger = page.getByRole("button", { name: "Terminal actions" });
    (trigger.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByRole("menuitem", { name: "New terminal", exact: true }))
      .toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(trigger).toHaveFocus();
    await expect
      .element(page.getByRole("menuitem", { name: "New terminal", exact: true }))
      .not.toBeInTheDocument();
    await screen.unmount();
  });
});

it("routes Search to the active terminal's existing find request", async () => {
  useSearchStore.setState({ terminalFindRequest: null });
  const screen = await render(<TerminalProfilePicker {...props()} />);
  await open();
  await page.getByRole("menuitem", { name: "Search", exact: true }).click();
  expect(useSearchStore.getState().terminalFindRequest).toMatchObject({
    threadId,
    terminalId: "one",
    query: "",
    lineText: "",
  });
  useSearchStore.setState({ terminalFindRequest: null });
  await screen.unmount();
});

it("routes Rename to the existing rename action", async () => {
  const onRename = vi.fn();
  const screen = await render(<TerminalProfilePicker {...props()} onRename={onRename} />);
  await open();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  expect(onRename).toHaveBeenCalledOnce();
  await screen.unmount();
});

it("shows the configured find shortcut instead of assuming the default", async () => {
  const screen = await render(<TerminalProfilePicker {...props()} findShortcutLabel="Alt+F" />);
  try {
    await open();
    await expect
      .element(page.getByRole("menuitem", { name: "Search", exact: true }))
      .toHaveTextContent("Alt+F");
  } finally {
    await screen.unmount();
  }
});
