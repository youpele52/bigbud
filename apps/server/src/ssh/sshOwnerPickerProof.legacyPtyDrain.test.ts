import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { drainOwnedSshMastersWith } from "./sshSession.ownedMasters.ts";
import {
  drainablePanes,
  runLegacyDrain,
  type LegacyDrainInput,
  type LegacyDrainPane,
} from "./sshLegacyDrain.ts";

const pane = (overrides: Partial<LegacyDrainPane> = {}): LegacyDrainPane => ({
  paneId: "pane-1",
  threadId: "thread-1",
  threadTitle: "Parser work",
  title: "build shell",
  surface: "direct-ssh",
  leaseId: "lease-1",
  keepMode: false,
  ...overrides,
});

const harness = (overrides: Partial<LegacyDrainInput> = {}) => {
  const events: string[] = [];
  const closed: string[] = [];
  const base: LegacyDrainInput = {
    trigger: "updater",
    profileScope: "state-dir",
    artifactId: "build-a",
    stopMonitors: Effect.sync(() => events.push("monitors")),
    stopRelays: Effect.sync(() => events.push("relays")),
    stopProviders: Effect.sync(() => events.push("providers")),
    listPanes: Effect.succeed([pane()]),
    consent: () => Effect.succeed({ kind: "proceed", choice: "drain-now" }),
    closePane: (item) =>
      Effect.sync(() => {
        closed.push(`${item.paneId}:${item.leaseId ?? "none"}`);
        events.push(`close:${item.paneId}`);
      }),
    closeOwnedMasters: Effect.sync(() => {
      events.push("masters");
      return { closed: 1, failed: 0 };
    }),
    commit: () =>
      Effect.sync(() => {
        events.push("commit");
      }),
    releaseLock: Effect.sync(() => events.push("release")),
    ...overrides,
  };
  return { events, closed, input: base };
};

it.effect("runs monitor, relay and provider stop before consent, then exact-lease closes", () =>
  Effect.gen(function* () {
    const { events, closed, input } = harness();
    const outcome = yield* runLegacyDrain(input);
    assert.equal(outcome.kind, "drained");
    assert.deepEqual(events, [
      "monitors",
      "relays",
      "providers",
      "close:pane-1",
      "masters",
      "commit",
      "release",
    ]);
    assert.deepEqual(closed, ["pane-1:lease-1"]);
    assert.deepEqual(
      outcome.drained.map((item) => [item.threadId, item.paneId, item.leaseId]),
      [["thread-1", "pane-1", "lease-1"]],
    );
  }),
);

it.effect("does nothing on a normal quit and nothing is drained", () =>
  Effect.gen(function* () {
    const { events, input } = harness({ trigger: "normal-quit" as never });
    const outcome = yield* runLegacyDrain(input);
    assert.equal(outcome.kind, "unsupported");
    assert.deepEqual(events, []);
  }),
);

it.effect("Cancel retains the lock and writes no marker", () =>
  Effect.gen(function* () {
    const { events, input } = harness({
      consent: () => Effect.succeed({ kind: "cancel" }),
    });
    const outcome = yield* runLegacyDrain(input);
    assert.equal(outcome.kind, "cancelled");
    // The stop phase precedes the dialog by plan; nothing else may follow Cancel.
    assert.deepEqual(events, ["monitors", "relays", "providers"]);
  }),
);

it.effect("drains direct SSH even in keep mode, leaves local alone, and honours U6 remotely", () =>
  Effect.gen(function* () {
    const panes = [
      pane({ paneId: "direct", keepMode: true }),
      pane({ paneId: "local", surface: "local", keepMode: true }),
      pane({ paneId: "kept-remote", surface: "remote-agent", keepMode: true }),
      pane({ paneId: "drained-remote", surface: "remote-agent", keepMode: false }),
    ];
    assert.deepEqual(
      drainablePanes(panes).map((item) => item.paneId),
      ["direct", "drained-remote"],
    );
    const { closed, input } = harness({ listPanes: Effect.succeed(panes) });
    const outcome = yield* runLegacyDrain(input);
    assert.deepEqual(closed, ["direct:lease-1", "drained-remote:lease-1"]);
    assert.deepEqual(
      outcome.preserved.map((item) => item.paneId),
      ["local", "kept-remote"],
    );
  }),
);

it.effect("save and close persists each pane before closing it, with no respawn", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const { input } = harness({
      listPanes: Effect.succeed([pane({ paneId: "a" }), pane({ paneId: "b" })]),
      consent: () => Effect.succeed({ kind: "proceed", choice: "save-and-close" }),
      savePane: (item) => Effect.sync(() => events.push(`save:${item.paneId}`)),
      closePane: (item) => Effect.sync(() => events.push(`close:${item.paneId}`)),
    });
    yield* runLegacyDrain(input);
    assert.deepEqual(events, ["save:a", "close:a", "save:b", "close:b"]);
  }),
);

it.effect("never writes the marker or releases the lock after a partial close failure", () =>
  Effect.gen(function* () {
    const { events, input, closed } = harness({
      listPanes: Effect.succeed([pane({ paneId: "a" }), pane({ paneId: "b" })]),
      closePane: (item) =>
        item.paneId === "b"
          ? Effect.fail(new Error("pane b is stuck"))
          : Effect.sync(() => {
              closed.push(item.paneId);
              events.push(`close:${item.paneId}`);
            }),
    });
    const result = yield* Effect.exit(runLegacyDrain(input));
    assert.isTrue(result._tag === "Failure");
    assert.deepEqual(closed, ["a"]);
    assert.equal(events.includes("commit"), false);
    assert.equal(events.includes("release"), false);
  }),
);

it.effect("does not write the marker when an owned master refuses to exit", () =>
  Effect.gen(function* () {
    const { events, input } = harness({
      closeOwnedMasters: Effect.succeed({ closed: 0, failed: 1 }),
    });
    const result = yield* Effect.exit(runLegacyDrain(input));
    assert.isTrue(result._tag === "Failure");
    assert.equal(events.includes("commit"), false);
    assert.equal(events.includes("release"), false);
  }),
);

it.effect("exits only the recorded masters and never guesses ambient sockets", () =>
  Effect.gen(function* () {
    const calls: string[][] = [];
    const result = yield* Effect.promise(() =>
      drainOwnedSshMastersWith(
        [
          {
            executionTargetId: "ssh://builder@host:2222",
            controlPath: "/tmp/bbs-owned-one",
            destination: "builder@host",
          },
          {
            executionTargetId: "ssh://builder@host-two:2222",
            controlPath: "/tmp/bbs-owned-two",
            destination: "builder@host-two",
          },
        ],
        {
          run: async (args) => {
            calls.push([...args]);
            return { status: 0 };
          },
          exists: (controlPath) => controlPath === "/tmp/bbs-owned-one",
        },
      ),
    );
    assert.deepEqual(result, { closed: 1, failed: 0 });
    // Only the existing owned master is exited; the missing one is already closed.
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[1], "exit");
    assert.equal(calls[0]?.[3], "ControlPath=/tmp/bbs-owned-one");
    assert.equal(calls[0]?.at(-1), "builder@host");
  }),
);
