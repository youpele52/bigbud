import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import {
  bindTerminalLaunch,
  recordTerminalLaunch,
  forgetTerminalLaunch,
} from "../../lib/terminalLaunchBinding";
import { TerminalProfilePicker } from "./TerminalProfilePicker";
const mocks = vi.hoisted(() => ({ shellProfiles: vi.fn() }));
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({ terminal: { shellProfiles: mocks.shellProfiles } }),
}));
const threadId = ThreadId.makeUnsafe("automatic-browser");
const host = { kind: "ssh", hostId: "remote" } as const;
afterEach(() => {
  forgetTerminalLaunch(threadId, "failed");
  vi.clearAllMocks();
});
it("offers explicit Automatic without session, inventory, or a successful snapshot", async () => {
  bindTerminalLaunch(threadId, "failed", {
    cwd: "/original",
    executionTargetId: "ssh:original",
    worktreePath: null,
  });
  mocks.shellProfiles.mockRejectedValue(new Error("No server session"));
  const onNewTerminal = vi.fn();
  const screen = await render(
    <TerminalProfilePicker threadId={threadId} terminalId="failed" onNewTerminal={onNewTerminal} />,
  );
  await screen.getByRole("button", { name: "Terminal actions" }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("No server session");
  await expect
    .element(screen.getByRole("menuitem", { name: "New terminal", exact: true }))
    .toBeDisabled();
  await screen.getByRole("menuitem", { name: "Open Automatic terminal" }).click();
  expect(onNewTerminal).toHaveBeenCalledWith({
    shellSelection: { kind: "legacy-auto" },
    source: { terminalId: "failed", runtimeGeneration: undefined },
  });
  await screen.unmount();
});
it.each([
  { exactProfileLaunchesEnabled: false, runtimeGeneration: "current" },
  { runtimeGeneration: "current" },
  { exactProfileLaunchesEnabled: true, runtimeGeneration: "stale" },
])("keeps exact actions closed without current server permission: %j", async (capability) => {
  recordTerminalLaunch({
    threadId,
    terminalId: "failed",
    cwd: "/original",
    executionTargetId: "ssh:original",
    worktreePath: null,
    status: "running",
    pid: 10,
    history: "",
    exitCode: null,
    exitSignal: null,
    dropPathMode: "posix",
    updatedAt: "2026-11-11T00:00:00Z",
    runtimeGeneration: "current",
  });
  mocks.shellProfiles.mockResolvedValue({ host, profiles: [], ...capability });
  const screen = await render(
    <TerminalProfilePicker threadId={threadId} terminalId="failed" onNewTerminal={vi.fn()} />,
  );
  await screen.getByRole("button", { name: "Terminal actions" }).click();
  await expect
    .element(screen.getByRole("menuitem", { name: "New terminal", exact: true }))
    .toBeDisabled();
  await expect.element(screen.getByRole("menuitem", { name: "Change shell" })).toBeDisabled();
  await expect
    .element(screen.getByRole("menuitem", { name: "Open Automatic terminal" }))
    .toBeEnabled();
  await screen.unmount();
});
