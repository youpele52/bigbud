import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";

import {
  DESKTOP_LIFECYCLE_HINT_FD,
  DesktopBackendStartReason,
  DesktopLifecycleHint,
  DesktopLifecycleHintAck,
  DesktopLifecycleHintFd,
  DesktopLifecycleHintLine,
} from "./desktopLifecycleHint";

const decodeHint = Schema.decodeUnknownEffect(DesktopLifecycleHint);

it("uses fd 5 for the lifecycle hint pipe", () => {
  assert.strictEqual(DESKTOP_LIFECYCLE_HINT_FD, 5);
});

it.effect("decodes each hint kind and an unknown online state", () =>
  Effect.gen(function* () {
    for (const kind of ["suspend", "resume", "online", "offline"] as const) {
      const hint = yield* decodeHint({
        kind,
        sequence: 3,
        occurredAt: 1_761_140_000_000,
        online: null,
      });
      assert.strictEqual(hint.kind, kind);
    }
  }),
);

it.effect("rejects renderer-only connectivity kinds", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      decodeHint({ kind: "lock-screen", sequence: 1, occurredAt: 1, online: true }),
    );
    assert.ok(Exit.isFailure(exit));
  }),
);

it.effect("decodes both restart reasons and rejects an ordinary start", () =>
  Effect.gen(function* () {
    const decodeReason = Schema.decodeUnknownEffect(DesktopBackendStartReason);
    for (const reason of ["resume-probe-restart", "unexpected-exit-restart"] as const) {
      assert.strictEqual(yield* decodeReason(reason), reason);
    }
    assert.ok(Exit.isFailure(yield* Effect.exit(decodeReason("ordinary"))));
  }),
);

it.effect("decodes the announced hint fd and rejects a negative one", () =>
  Effect.gen(function* () {
    const decodeFd = Schema.decodeUnknownEffect(DesktopLifecycleHintFd);
    assert.strictEqual(yield* decodeFd(DESKTOP_LIFECYCLE_HINT_FD), 5);
    assert.ok(Exit.isFailure(yield* Effect.exit(decodeFd(-1))));
  }),
);

it.effect("decodes quit lines with and without a reason, and keeps power hints quit-free", () =>
  Effect.gen(function* () {
    const decodeLine = Schema.decodeUnknownEffect(DesktopLifecycleHintLine);
    const base = { kind: "quit", sequence: 9, occurredAt: 1_761_140_000_000, online: true };
    for (const reason of ["quit", "update", "restart"] as const) {
      assert.deepStrictEqual(yield* decodeLine({ ...base, reason }), { ...base, reason });
    }
    assert.deepStrictEqual(yield* decodeLine(base), base);
    assert.ok(Exit.isFailure(yield* Effect.exit(decodeLine({ ...base, reason: "crash" }))));
    const resume = { kind: "resume", sequence: 2, occurredAt: 1, online: null };
    assert.deepStrictEqual(yield* decodeLine(resume), resume);
    // An older server decodes only `DesktopLifecycleHint`, so it drops a quit line.
    assert.ok(Exit.isFailure(yield* Effect.exit(decodeHint(base))));
  }),
);

it.effect("decodes the server's acknowledgement by sequence", () =>
  Effect.gen(function* () {
    const decodeAck = Schema.decodeUnknownEffect(DesktopLifecycleHintAck);
    assert.deepStrictEqual(yield* decodeAck({ sequence: 9 }), { sequence: 9 });
    assert.ok(Exit.isFailure(yield* Effect.exit(decodeAck({ sequence: -1 }))));
  }),
);
