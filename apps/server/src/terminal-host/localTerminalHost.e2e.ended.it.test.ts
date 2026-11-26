/**
 * Ended terminals with the real binary (`BIGBUD_TERMINAL_HOST_IT=1`): a terminal the host closed
 * for idleness is never respawned by a later plain open (a parked view coming back), and it no
 * longer counts as running in the inventory. A terminal kept across a backend restart that no
 * view reopened is still closed, through the host, when its thread is deleted or archived. The
 * idle close uses the debug host clock `BIGBUD_DEBUG_TERMINAL_IDLE_MS` (debug builds only).
 */
import type { TerminalSessionInventory } from "@bigbud/contracts/workspace/terminal.stream.ts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  hostE2eEnabled,
  hostProcesses,
  makeHostE2eWorld,
  runEffect,
  until,
  type HostE2eBackend,
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

const GEOMETRY = { cols: 80, rows: 24 };

const watchInventory = async (backend: HostE2eBackend) => {
  const inventories: TerminalSessionInventory[] = [];
  await runEffect(
    backend.manager.subscribe(() => Effect.void, {
      onInventory: (inventory) => Effect.sync(() => inventories.push(inventory)),
    }),
  );
  return inventories;
};

describe.skipIf(!hostE2eEnabled)("ended terminals with the real binary", () => {
  it("never respawns an idle-closed terminal on a plain open, and stops counting it", async () => {
    process.env.BIGBUD_DEBUG_TERMINAL_IDLE_MS = "4000";
    const w = await world();
    const backend = await w.backend();
    const inventories = await watchInventory(backend);
    const pane = { threadId: "t", terminalId: "prompt", cwd: w.cwd, ...GEOMETRY };
    const opened = await runEffect(backend.manager.open(pane));
    expect(opened.status).toBe("running");

    await until(
      () => backend.notices.some((n) => n.kind === "idleClosed" && n.terminalId === "prompt"),
      "the idle close",
      15_000,
    );
    await until(() => !hostProcesses.isAlive(opened.pid!), "the shell to exit", 5_000);

    // The parked view comes back and opens without attachOnly: nothing is spawned.
    const reopened = await runEffect(backend.manager.open(pane));
    expect(reopened).toMatchObject({ status: "exited", pid: null, endedReason: "idle" });
    const starts = backend.events.filter(
      (event) => event.type === "started" && event.terminalId === "prompt",
    );
    expect(starts).toHaveLength(1);

    // The inventory sent after the close still lists the pane, but not as running.
    await until(
      () =>
        inventories
          .at(-1)
          ?.sessions.some((entry) => entry.terminalId === "prompt" && entry.live === false) ===
        true,
      "the refreshed inventory",
    );
    await backend.close();
  }, 60_000);

  it("closes a terminal kept across a backend restart when its thread is archived", async () => {
    const w = await world();
    const first = await w.backend({ keepRunningAfterQuit: () => true });
    const kept = await runEffect(
      first.manager.open({ threadId: "t", terminalId: "kept", cwd: w.cwd, ...GEOMETRY }),
    );
    // A backend restart: no quit hint, so the host keeps the shell.
    await first.close();
    expect(hostProcesses.isAlive(kept.pid!)).toBe(true);

    const second = await w.backend({ keepRunningAfterQuit: () => true });
    const inventories = await watchInventory(second);
    // No view reopened it: only the host roster knows the pane.
    expect(inventories[0]?.sessions.map((entry) => entry.terminalId)).toEqual(["kept"]);
    await runEffect(second.manager.close({ threadId: "t" }));
    await until(() => !hostProcesses.isAlive(kept.pid!), "the kept shell to exit", 5_000);
    await second.close();
  }, 60_000);
});
