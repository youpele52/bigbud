/**
 * Q1 end-to-end with the real binary (`BIGBUD_TERMINAL_HOST_IT=1`): a quit with the default
 * setting leaves no shell and (after the host's self-exit delay, shortened with the debug-only
 * and terminals the host closed while bigbud was closed come back as one "while bigbud was
 */
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  hostE2eEnabled,
  hostProcesses,
  makeHostE2eWorld,
  quitIntent,
  runEffect,
  sleep,
  until,
  watchPane,
  type HostE2eWorld,
} from "./localTerminalHost.e2e.testUtils.ts";

const DEBUG_ENV = ["BIGBUD_DEBUG_TERMINAL_IDLE_MS", "BIGBUD_DEBUG_TERMINAL_HOST_SELF_EXIT_MS"];
const saved = new Map(DEBUG_ENV.map((name) => [name, process.env[name]]));
const worlds: HostE2eWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
  for (const [name, value] of saved)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
});
const world = async () => {
  const created = await makeHostE2eWorld();
  worlds.push(created);
  return created;
};

const GEOMETRY = { cols: 80, rows: 24 };
const quitting = (keepRunningAfterQuit: boolean) => ({
  resolveQuitIntent: quitIntent("quit"),
  keepRunningAfterQuit: () => keepRunningAfterQuit,
});

describe.skipIf(!hostE2eEnabled)("Q1 quit flows with the real binary", () => {
  it("quit with the default setting leaves no shell and no host", async () => {
    process.env.BIGBUD_DEBUG_TERMINAL_HOST_SELF_EXIT_MS = "1500";
    const w = await world();
    const backend = await w.backend(quitting(false));
    const pane = { threadId: "t", terminalId: "default", cwd: w.cwd, ...GEOMETRY };
    const opened = await runEffect(backend.manager.open(pane));
    const hosts = await w.hostPids();
    expect(hosts.length).toBeGreaterThan(0);
    await backend.close();
    await until(() => !hostProcesses.isAlive(opened.pid!), "the shell to exit", 3_500);
    await until(
      () => hosts.every((pid) => !hostProcesses.isAlive(pid)),
      "the orphaned, empty host to exit",
      10_000,
    );

    // Relaunch: nothing to restore, so an attach-only reopen finds no terminal.
    const relaunched = await w.backend();
    const reopened = await runEffect(
      Effect.flip(relaunched.manager.open({ ...pane, attachOnly: true })),
    );
    expect(reopened._tag).toBe("TerminalNotRunningError");
    await relaunched.close();
  }, 60_000);

  it("keep mode survives the quit and reattaches with the same PID and screen", async () => {
    const w = await world();
    const first = await w.backend(quitting(true));
    const pane = { threadId: "t", terminalId: "default", cwd: w.cwd, ...GEOMETRY };
    const opened = await runEffect(first.manager.open(pane));
    await runEffect(first.manager.write({ ...pane, data: "echo kept-$((20+3))\r" }));
    await until(() => (first.output.get("t/default") ?? "").includes("kept-23"), "output");
    await sleep(600);
    await first.close();
    await sleep(2_000);
    expect(hostProcesses.isAlive(opened.pid!)).toBe(true);

    const second = await w.backend();
    const view = await watchPane(second, "t", "default");
    const reopened = await runEffect(second.manager.open({ ...pane, attachOnly: true }));
    expect(reopened.pid).toBe(opened.pid);
    await until(() => view.screens.length > 0, "the screen item");
    expect(view.screens[0]!.ansi).toContain("kept-23");
    view.stop();
    await second.close();
  }, 60_000);

  it("summarises the terminals the host closed while bigbud was closed", async () => {
    process.env.BIGBUD_DEBUG_TERMINAL_IDLE_MS = "3000";
    const w = await world();
    const first = await w.backend(quitting(true));
    const pane = (terminalId: string) => ({ threadId: "t", terminalId, cwd: w.cwd, ...GEOMETRY });
    const a = await runEffect(first.manager.open(pane("a")));
    const b = await runEffect(first.manager.open(pane("b")));
    // Keep them busy until the quit, so neither closes while bigbud is still running.
    await runEffect(first.manager.write({ ...pane("a"), data: "sleep 2\r" }));
    await runEffect(first.manager.write({ ...pane("b"), data: "sleep 2\r" }));
    await sleep(600);
    await first.close();
    // bigbud is closed: both prompts go idle and the host closes them.
    await until(
      () => !hostProcesses.isAlive(a.pid!) && !hostProcesses.isAlive(b.pid!),
      "the idle closes while bigbud is closed",
      20_000,
    );

    const second = await w.backend();
    await until(
      () => second.notices.some((notice) => notice.kind === "offlineClosed"),
      "the offline summary",
      10_000,
    );
    const summary = second.notices.filter((notice) => notice.kind === "offlineClosed");
    expect(summary).toHaveLength(1);
    expect(summary[0]!.count).toBe(2);
    await second.close();

    // The cursor moved past them: a third launch raises no summary again.
    const third = await w.backend();
    await sleep(1_500);
    expect(third.notices.filter((notice) => notice.kind === "offlineClosed")).toEqual([]);
    await third.close();
  }, 90_000);
});
