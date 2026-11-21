import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { describe, expect, it as vitest } from "vitest";

import type { AppQuitIntentRecord } from "../../lifecycle/AppQuitIntent.ts";
import {
  FakeHostAdapter,
  type FakeHostProcess,
  makeHostManager,
} from "./Manager.host.test.helpers.ts";
import { decideTerminalQuit } from "./Manager.quitPolicy.ts";
import { openInput } from "./Manager.test.helpers.ts";

const intent = (reason: AppQuitIntentRecord["reason"]) =>
  Option.some({ sequence: 1, reason, occurredAt: 1 });

describe("terminal quit decision", () => {
  vitest("closes on a user quit or restart and on an update; keep mode or no hint detaches", () => {
    expect(decideTerminalQuit(intent("quit"), false)).toEqual({ kind: "close", reason: "quit" });
    expect(decideTerminalQuit(intent("restart"), false)).toEqual({ kind: "close", reason: "quit" });
    expect(decideTerminalQuit(intent("update"), false)).toEqual({
      kind: "close",
      reason: "update",
    });
    expect(decideTerminalQuit(intent("quit"), true)).toEqual({ kind: "detach", why: "keep" });
    expect(decideTerminalQuit(intent("update"), true)).toEqual({ kind: "detach", why: "keep" });
    expect(decideTerminalQuit(Option.none(), false)).toEqual({ kind: "detach", why: "no-hint" });
  });
});

/** Builds and stops one backend; returns the host's close-all calls and the PTY. */
const stopBackend = (input: {
  readonly intent: Option.Option<AppQuitIntentRecord>;
  readonly keep: boolean;
}) =>
  Effect.gen(function* () {
    const adapter = new FakeHostAdapter();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { manager } = yield* makeHostManager(adapter, {
          keepRunningAfterQuit: () => input.keep,
          resolveQuitIntent: Effect.succeed(input.intent),
        });
        yield* manager.open(openInput());
      }),
    );
    return {
      calls: adapter.generations.closeAllCalls,
      process: adapter.processes[0] as FakeHostProcess,
    };
  });

it.layer(NodeServices.layer, { excludeTestServices: true })("terminal quit on shutdown", (it) => {
  it.effect("quit with the default setting closes managed terminals on every generation", () =>
    Effect.gen(function* () {
      const { calls, process } = yield* stopBackend({ intent: intent("quit"), keep: false });
      expect(calls).toEqual([{ reason: "quit", managedOnly: true }]);
      // Sessions still detach afterwards; the backend never kills a host PTY itself.
      expect(process.killed).toBe(false);
      expect(process.detach).toHaveBeenCalled();
    }),
  );

  it.effect("quit in keep mode detaches", () =>
    Effect.gen(function* () {
      const { calls, process } = yield* stopBackend({ intent: intent("quit"), keep: true });
      expect(calls).toEqual([]);
      expect(process.detach).toHaveBeenCalled();
    }),
  );

  it.effect("an update with the default setting closes with reason update", () =>
    Effect.gen(function* () {
      const { calls } = yield* stopBackend({ intent: intent("update"), keep: false });
      expect(calls).toEqual([{ reason: "update", managedOnly: true }]);
    }),
  );

  it.effect("a stop without a hint detaches", () =>
    Effect.gen(function* () {
      const { calls, process } = yield* stopBackend({ intent: Option.none(), keep: false });
      expect(calls).toEqual([]);
      expect(process.killed).toBe(false);
    }),
  );
});
