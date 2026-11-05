import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import { afterEach, expect, it, vi } from "vitest";
import { forgetTerminalLaunch, recordTerminalLaunch } from "../../lib/terminalLaunchBinding";
import { resolveTerminalViewportSnapshot } from "./TerminalViewport.snapshot";

const old: TerminalSessionSnapshot = {
  threadId: "snapshot-baseline",
  terminalId: "shell",
  cwd: "/old",
  worktreePath: null,
  dropPathMode: "posix",
  status: "running",
  pid: 1,
  runtimeGeneration: "same",
  history: "old",
  exitCode: null,
  exitSignal: null,
  updatedAt: "2026-10-29T12:00:01Z",
};
const fresh = { ...old, cwd: "/fresh", history: "fresh", updatedAt: "2026-10-29T12:00:02Z" };
afterEach(() => forgetTerminalLaunch(old.threadId, old.terminalId));

it.each([null, old.updatedAt])(
  "fetches read-only history when only global metadata is newer and local cutoff is %s",
  async (localUpdatedAt) => {
    recordTerminalLaunch(fresh);
    const refresh = vi.fn(async () => fresh);
    expect(
      await resolveTerminalViewportSnapshot(old, {
        localUpdatedAt: () => localUpdatedAt,
        disposed: () => false,
        refresh,
      }),
    ).toBe(fresh);
    expect(refresh).toHaveBeenCalledOnce();
  },
);

it("uses an already-staged current local baseline without another snapshot RPC", async () => {
  recordTerminalLaunch(fresh);
  const refresh = vi.fn();
  expect(
    await resolveTerminalViewportSnapshot(old, {
      localUpdatedAt: () => fresh.updatedAt,
      disposed: () => false,
      refresh,
    }),
  ).toBe(old);
  expect(refresh).not.toHaveBeenCalled();
});

it("reports a still-stale authoritative response instead of silently finishing without history", async () => {
  recordTerminalLaunch(fresh);
  await expect(
    resolveTerminalViewportSnapshot(old, {
      localUpdatedAt: () => null,
      disposed: () => false,
      refresh: async () => old,
    }),
  ).rejects.toThrow("Reload the view");
});

it("ignores a snapshot refresh superseded by another delivery", async () => {
  recordTerminalLaunch(fresh);
  let disposed = false;
  expect(
    await resolveTerminalViewportSnapshot(old, {
      localUpdatedAt: () => null,
      disposed: () => disposed,
      refresh: async () => {
        disposed = true;
        return fresh;
      },
    }),
  ).toBeNull();
});
