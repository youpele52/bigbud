import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";

import {
  DESKTOP_LIFECYCLE_HINT_FD,
  DesktopBackendStartReason,
  DesktopLifecycleHint,
  DesktopLifecycleHintFd,
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
