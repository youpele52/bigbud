import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { TerminalLifecycleNotice } from "@bigbud/contracts/workspace/terminal.lifecycle.ts";
import { Effect } from "effect";
import { describe, expect, it as vitest } from "vitest";

import type { OwnedPtyHostEvent } from "../Services/OwnedPtyRuntime.ts";
import { TerminalHostClosedTombstones } from "./Manager.hostClosed.tombstones.ts";
import {
  FakeHostAdapter,
  type FakeHostProcess,
  flush,
  makeHostManager,
} from "./Manager.host.test.helpers.ts";
import { openInput } from "./Manager.test.helpers.ts";
import type { TerminalSessionState } from "./Manager.types.ts";

const ended = (
  terminalId: string,
  endedReason: TerminalSessionState["endedReason"],
  ptyId = `pty-${terminalId}`,
) =>
  ({
    threadId: "t",
    terminalId,
    process: null,
    status: "exited",
    endedReason,
    host: { lifecycle: true, ptyId },
  }) as unknown as TerminalSessionState;

describe("host-closed tombstones", () => {
  vitest("remembers evicted host closes, bounded per thread and for 24 hours", () => {
    let now = 0;
    const tombstones = new TerminalHostClosedTombstones({ perThread: 2, now: () => now });
    tombstones.record(ended("a", "idle"));
    tombstones.record(ended("b", "memory"));
    tombstones.record(ended("c", "exited"));
    expect(tombstones.find("t", "a")).toBe("idle");
    expect(tombstones.find("t", "b")).toBe("memory");
    // A plain exit is no tombstone: that shell reopens exactly as before.
    expect(tombstones.find("t", "c")).toBeUndefined();
    tombstones.record(ended("d", "orphan"));
    // The oldest goes past the per-thread bound.
    expect(tombstones.find("t", "a")).toBeUndefined();
    expect(tombstones.find("t", "d")).toBe("orphan");
    now = 24 * 60 * 60 * 1000 + 1;
    expect(tombstones.find("t", "d")).toBeUndefined();
  });

  vitest("lets a late close notice find an evicted pane, and a later plain exit clears it", () => {
    const tombstones = new TerminalHostClosedTombstones();
    tombstones.record(ended("a", "exited", "pty-9"));
    expect(tombstones.paneForPty("pty-9")).toEqual({ threadId: "t", terminalId: "a" });
    tombstones.recordClosed({ threadId: "t", terminalId: "a" }, "idle");
    tombstones.recordClosed({ threadId: "t", terminalId: "q" }, "quit");
    expect(tombstones.find("t", "a")).toBe("idle");
    expect(tombstones.find("t", "q")).toBeUndefined();
    tombstones.record(ended("a", "exited", "pty-10"));
    expect(tombstones.find("t", "a")).toBeUndefined();
  });
});

function hostWithEvents() {
  const adapter = new FakeHostAdapter();
  let listener: ((event: OwnedPtyHostEvent) => void) | undefined;
  Object.assign(adapter.runtime, {
    host: {
      subscribe: async (next: (event: OwnedPtyHostEvent) => void) => {
        listener = next;
        return () => undefined;
      },
    },
  });
  const notice = (ptyId: string, kind: string, noticeId: number) =>
    listener!({
      type: "notice",
      value: { ptyId, kind, noticeId, closesAtMs: 0, occurredAtMs: 1_700_000_000_000 },
    });
  return { adapter, notice };
}

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "evicted host-closed terminals",
  (it) => {
    it.effect("a plain open of an evicted idle-closed terminal still returns ended", () =>
      Effect.gen(function* () {
        const adapter = new FakeHostAdapter();
        const { manager } = yield* makeHostManager(adapter, { maxRetainedInactiveSessions: 0 });
        yield* manager.open(openInput());
        yield* Effect.promise(flush);
        const process = adapter.processes[0] as FakeHostProcess;
        process.emitNotice("idle_closed");
        process.emitExit({ exitCode: 143, signal: 15 });
        yield* Effect.promise(flush);
        // Evicted: the manager no longer retains the session.
        expect(adapter.spawnInputs).toHaveLength(1);
        const reopened = yield* manager.open(openInput());
        expect(reopened).toMatchObject({ status: "exited", pid: null, endedReason: "idle" });
        expect(adapter.spawnInputs).toHaveLength(1);
      }),
    );

    it.effect(
      "a close notice after the session was evicted as an exit still blocks a respawn",
      () =>
        Effect.gen(function* () {
          const { adapter, notice } = hostWithEvents();
          const { manager } = yield* makeHostManager(adapter, { maxRetainedInactiveSessions: 0 });
          const notices: TerminalLifecycleNotice[] = [];
          yield* manager.subscribeLifecycle!((item) => Effect.sync(() => notices.push(item)));
          yield* manager.open(openInput());
          yield* Effect.promise(flush);
          (adapter.processes[0] as FakeHostProcess).emitExit({ exitCode: 143, signal: 15 });
          yield* Effect.promise(flush);
          notice("pty-1", "idle_closed", 4);
          yield* Effect.promise(flush);
          // The notice still names the pane, so the web removes it.
          expect(notices.map((item) => [item.kind, item.terminalId])).toEqual([
            ["idleClosed", "default"],
          ]);
          const reopened = yield* manager.open(openInput());
          expect(reopened).toMatchObject({ status: "exited", endedReason: "idle" });
          expect(adapter.spawnInputs).toHaveLength(1);
          // A user-exited shell (no host close) still reopens, as before.
          yield* manager.open(openInput({ terminalId: "other" }));
          (adapter.processes[1] as FakeHostProcess).emitExit({ exitCode: 0, signal: null });
          yield* Effect.promise(flush);
          yield* manager.open(openInput({ terminalId: "other" }));
          expect(adapter.spawnInputs).toHaveLength(3);
        }),
    );
  },
);
