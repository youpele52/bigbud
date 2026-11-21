/**
 * Q1 end-to-end with the real binary (`BIGBUD_TERMINAL_HOST_IT=1`): the idle warning, "Keep
 * open" and the idle close, driven by the debug host clock `BIGBUD_DEBUG_TERMINAL_IDLE_MS`
 * (debug builds only; the warning lead becomes half the timeout), and the live limit's refusal
 * naming the least recently used hidden terminal, then its eviction.
 */
import { TerminalLimitError } from "@bigbud/contracts/workspace/terminal.limit.ts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  hostE2eEnabled,
  hostProcesses,
  makeHostE2eWorld,
  runEffect,
  sleep,
  until,
  type HostE2eWorld,
} from "./localTerminalHost.e2e.testUtils.ts";

const worlds: HostE2eWorld[] = [];
const savedIdle = process.env.BIGBUD_DEBUG_TERMINAL_IDLE_MS;
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
  if (savedIdle === undefined) delete process.env.BIGBUD_DEBUG_TERMINAL_IDLE_MS;
  else process.env.BIGBUD_DEBUG_TERMINAL_IDLE_MS = savedIdle;
});
const world = async () => {
  const created = await makeHostE2eWorld();
  worlds.push(created);
  return created;
};

const IDLE_MS = 4_000;
const GEOMETRY = { cols: 80, rows: 24 };

describe.skipIf(!hostE2eEnabled)("Q1 lifecycle flows with the real binary", () => {
  it("warns, keeps open on request, then idle-closes only the hidden prompt", async () => {
    process.env.BIGBUD_DEBUG_TERMINAL_IDLE_MS = String(IDLE_MS);
    const w = await world();
    const backend = await w.backend();
    const pane = (terminalId: string) => ({ threadId: "t", terminalId, cwd: w.cwd, ...GEOMETRY });
    const prompt = await runEffect(backend.manager.open(pane("prompt")));
    const visible = await runEffect(backend.manager.open(pane("visible")));
    const busy = await runEffect(backend.manager.open(pane("busy")));
    backend.views.update("renderer", { threadId: "t", terminalIds: ["visible"] });
    // A foreground program counts as busy, never idle.
    await runEffect(backend.manager.write({ ...pane("busy"), data: "exec sleep 900\r" }));
    const kinds = (terminalId: string) =>
      backend.notices.filter((notice) => notice.terminalId === terminalId).map((n) => n.kind);

    await until(() => kinds("prompt").includes("idleWarning"), "the idle warning", 8_000);
    const warning = backend.notices.find((notice) => notice.kind === "idleWarning")!;
    expect(Date.parse(warning.closesAt!)).toBeGreaterThan(Date.now());
    await runEffect(backend.manager.keepOpen!({ threadId: "t", terminalId: "prompt" }));
    await until(() => kinds("prompt").includes("idleWarningCleared"), "the cleared warning");
    expect(hostProcesses.isAlive(prompt.pid!)).toBe(true);

    await until(() => kinds("prompt").includes("idleClosed"), "the idle close", 10_000);
    await until(() => !hostProcesses.isAlive(prompt.pid!), "the prompt shell to exit", 5_000);
    const snapshot = await runEffect(
      backend.manager.snapshot({ threadId: "t", terminalId: "prompt" }),
    );
    expect(snapshot.endedReason).toBe("idle");
    // Two more idle periods: the visible prompt and the busy program are never closed.
    await sleep(IDLE_MS * 2);
    expect(kinds("visible")).not.toContain("idleClosed");
    expect(kinds("busy")).not.toContain("idleClosed");
    expect(hostProcesses.isAlive(visible.pid!)).toBe(true);
    expect(hostProcesses.isAlive(busy.pid!)).toBe(true);
    await backend.close();
  }, 60_000);

  it("refuses the 25th terminal naming the oldest hidden one, then evicts it", async () => {
    const w = await world();
    const backend = await w.backend();
    const pane = (index: number) => ({
      threadId: `thread-${index}`,
      terminalId: "default",
      cwd: w.cwd,
      ...GEOMETRY,
    });
    const pids: number[] = [];
    for (let index = 0; index < 24; index++) {
      pids.push((await runEffect(backend.manager.open(pane(index)))).pid!);
      await sleep(20);
    }
    // The oldest terminal is on screen, so it is never the one offered for closing.
    backend.views.update("renderer", { threadId: "thread-0", terminalIds: ["default"] });
    await sleep(200);

    const refusal = await runEffect(Effect.flip(backend.manager.open(pane(24))));
    expect(refusal).toBeInstanceOf(TerminalLimitError);
    const limit = refusal as TerminalLimitError;
    expect(limit).toMatchObject({ limit: 24, liveCount: 24 });
    expect(limit.candidate).toMatchObject({ terminalId: "default" });
    expect(limit.candidate!.threadId).not.toBe("thread-0");
    const evicted = Number(limit.candidate!.threadId.slice("thread-".length));

    // Confirming closes the named terminal first, then opens the new one.
    const opened = await runEffect(
      backend.manager.open({
        ...pane(24),
        evict: { threadId: limit.candidate!.threadId, terminalId: "default" },
      }),
    );
    expect(opened.status).toBe("running");
    await until(() => !hostProcesses.isAlive(pids[evicted]!), "the evicted shell to exit", 5_000);
    await until(
      () =>
        backend.notices.some(
          (notice) => notice.kind === "limitClosed" && notice.threadId === `thread-${evicted}`,
        ),
      "the limit-closed notice",
    );
    expect(hostProcesses.isAlive(pids[0]!)).toBe(true);
    await backend.close();
  }, 90_000);
});
