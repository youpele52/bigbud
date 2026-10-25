import { expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";
import type { Terminal } from "@xterm/xterm";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { useTerminalResizeRequest } from "./TerminalViewport.resize";

const mocks = vi.hoisted(() => ({ resize: vi.fn<(...args: unknown[]) => Promise<void>>() }));
vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => ({ terminal: mocks }) }));

it("old resize completions cannot clear or replay the replacement view's pending resize", async () => {
  const resolve: Array<() => void> = [];
  mocks.resize.mockImplementation(
    () =>
      new Promise((done) => {
        resolve.push(done);
      }),
  );
  const terminalRef = { current: { cols: 80, rows: 24 } as Terminal | null };
  const hook = await renderHook(() =>
    useTerminalResizeRequest({
      terminalRef,
      threadId: ThreadId.makeUnsafe("synthetic"),
      terminalId: "synthetic",
    }),
  );
  try {
    hook.result.current();
    hook.result.current();
    expect(mocks.resize).toHaveBeenCalledTimes(1);
    terminalRef.current = { cols: 100, rows: 30 } as Terminal;
    hook.result.current();
    hook.result.current();
    expect(mocks.resize).toHaveBeenCalledTimes(2);
    resolve[0]!();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.resize).toHaveBeenCalledTimes(2);
    resolve[1]!();
    await expect.poll(() => mocks.resize.mock.calls.length).toBe(3);
    expect(mocks.resize).toHaveBeenLastCalledWith(expect.objectContaining({ cols: 100, rows: 30 }));
    resolve[2]!();
  } finally {
    await hook.unmount();
  }
});
