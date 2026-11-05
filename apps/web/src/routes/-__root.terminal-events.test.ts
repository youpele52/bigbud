import { beforeEach, expect, it, vi } from "vitest";
import type { NativeApi, TerminalEvent } from "@bigbud/contracts";
import type { TerminalSessionInventory } from "@bigbud/contracts/workspace/terminal.stream.ts";
import { subscribeGlobalTerminalState } from "./-__root.terminal-events";
import { useTerminalStateStore } from "../stores/terminal/terminal.store";
import { terminalEventBufferKey } from "../stores/terminal/helpers.store";
import {
  makeTerminalEvent,
  resetTerminalStore,
  THREAD_ID,
} from "../stores/terminal/terminal.store.test.helpers";

function fixture() {
  let emit!: (event: TerminalEvent) => void;
  let inventory!: (item: TerminalSessionInventory) => void;
  const unsubscribe = vi.fn();
  const terminal = {
    onEvent: (listener, options) => {
      emit = listener;
      inventory = options!.onInventory!;
      return unsubscribe;
    },
  } satisfies Pick<NativeApi["terminal"], "onEvent">;
  const store = useTerminalStateStore.getState();
  const stop = subscribeGlobalTerminalState({
    terminal,
    isArchived: (id) => id === "archived",
    applyEvents: store.applyTerminalEvents,
    reconcileInventory: store.reconcileTerminalInventory,
  });
  return { emit, inventory, stop, unsubscribe };
}

beforeEach(resetTerminalStore);

it("flushes pre-boundary events before clearing a missing session, then applies survivor replay", async () => {
  const store = useTerminalStateStore.getState();
  store.ensureTerminal(THREAD_ID, "default", { open: true });
  store.ensureTerminal(THREAD_ID, "wsl", { open: true });
  const { emit, inventory, stop } = fixture();
  try {
    for (const terminalId of ["default", "wsl"]) {
      emit(makeTerminalEvent("activity", { terminalId }));
      emit(makeTerminalEvent("agentIdentity", { terminalId, provider: "pi" }));
    }
    // Simulates resubscription after overflow discarded an exit and the manager deleted its session.
    inventory({
      type: "inventory",
      createdAt: "2026-04-02T20:00:01.000Z",
      sessions: [{ threadId: THREAD_ID, terminalId: "wsl" }],
    });
    emit(
      makeTerminalEvent("activity", {
        terminalId: "survivor",
        hasRunningSubprocess: false,
        createdAt: "2026-04-02T20:00:01.000Z",
      }),
    );
    await Promise.resolve();
    const after = useTerminalStateStore.getState();
    expect(after.terminalStateByThreadId[THREAD_ID]?.runningTerminalIds).toEqual(["wsl"]);
    expect(
      after.terminalAgentProviderByKey[terminalEventBufferKey(THREAD_ID, "default")],
    ).toBeUndefined();
    expect(after.terminalAgentProviderByKey[terminalEventBufferKey(THREAD_ID, "wsl")]).toBe("pi");
    expect(
      Object.values(after.terminalEventEntriesByKey)
        .flat()
        .some(({ event }) => event.type === "exited"),
    ).toBe(false);
  } finally {
    stop();
  }
});

it("drops pending work on disposal and ignores archived events without filtering global inventory", async () => {
  const { emit, inventory, stop, unsubscribe } = fixture();
  emit(makeTerminalEvent("activity", { threadId: "archived" }));
  await Promise.resolve();
  expect(useTerminalStateStore.getState().terminalEventEntriesByKey).toEqual({});
  emit(makeTerminalEvent("activity"));
  stop();
  const before = useTerminalStateStore.getState();
  inventory({ type: "inventory", createdAt: "2099-01-01T00:00:00.000Z", sessions: [] });
  emit(makeTerminalEvent("activity"));
  await Promise.resolve();
  expect(useTerminalStateStore.getState()).toBe(before);
  expect(unsubscribe).toHaveBeenCalledOnce();
});
