/**
 * A host-closed terminal across a backend restart, with the real binary
 * (`BIGBUD_TERMINAL_HOST_IT=1`). The new backend has no session or tombstone for a pane the host
 * closed under the old one, so the web marks every pane restored when the server run changes
 * (`terminal.store.serverRun`): this checks the server half of that contract. An attach-only open
 * of the closed pane fails with `TerminalNotRunningError` and spawns nothing (the web then drops
 * the pane), while a busy kept terminal reattaches to the same PID. The idle close uses the debug
 * host clock `BIGBUD_DEBUG_TERMINAL_IDLE_MS` (debug builds only).
 */
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

const GEOMETRY = { cols: 80, rows: 24 };

describe.skipIf(!hostE2eEnabled)("host-closed terminals across a backend restart", () => {
  it("an attach-only open of a pane closed under the old backend spawns nothing", async () => {
    process.env.BIGBUD_DEBUG_TERMINAL_IDLE_MS = "4000";
    const w = await makeHostE2eWorld();
    worlds.push(w);
    const pane = (terminalId: string) => ({ threadId: "t", terminalId, cwd: w.cwd, ...GEOMETRY });
    const first = await w.backend({ keepRunningAfterQuit: () => true });
    const closed = await runEffect(first.manager.open(pane("closed")));
    const busy = await runEffect(first.manager.open(pane("busy")));
    // A foreground program is busy, never idle: this one is kept across the restart.
    await runEffect(first.manager.write({ ...pane("busy"), data: "exec sleep 900\r" }));
    await until(
      () => first.notices.some((n) => n.kind === "idleClosed" && n.terminalId === "closed"),
      "the idle close",
      15_000,
    );
    await until(() => !hostProcesses.isAlive(closed.pid!), "the closed shell to exit", 5_000);
    // Let the debounced history writes land, then restart without a quit hint.
    await sleep(600);
    await first.close();
    expect(hostProcesses.isAlive(busy.pid!)).toBe(true);

    const second = await w.backend({ keepRunningAfterQuit: () => true });
    const failure = await runEffect(
      second.manager.open({ ...pane("closed"), attachOnly: true }).pipe(Effect.flip),
    );
    expect(failure).toMatchObject({ _tag: "TerminalNotRunningError", terminalId: "closed" });
    expect(
      second.events.filter((event) => event.type === "started" && event.terminalId === "closed"),
    ).toEqual([]);
    // The kept busy terminal reattaches to its PID (its `started` is the reattach, not a spawn).
    const reattached = await runEffect(second.manager.open({ ...pane("busy"), attachOnly: true }));
    expect(reattached).toMatchObject({ status: "running", pid: busy.pid });
    expect(hostProcesses.isAlive(closed.pid!)).toBe(false);

    await runEffect(second.manager.close({ threadId: "t" }));
    await until(() => !hostProcesses.isAlive(busy.pid!), "the kept shell to exit", 5_000);
    await second.close();
  }, 60_000);
});
