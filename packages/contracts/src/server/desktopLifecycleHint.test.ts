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

it.effect("decodes the resume-probe restart reason", () =>
  Effect.gen(function* () {
    const reason =
      yield* Schema.decodeUnknownEffect(DesktopBackendStartReason)("resume-probe-restart");
    assert.strictEqual(reason, "resume-probe-restart");
  }),
);

it.effect("decodes the announced hint fd and rejects a negative one", () =>
  Effect.gen(function* () {
    const decodeFd = Schema.decodeUnknownEffect(DesktopLifecycleHintFd);
    assert.strictEqual(yield* decodeFd(DESKTOP_LIFECYCLE_HINT_FD), 5);
    assert.ok(Exit.isFailure(yield* Effect.exit(decodeFd(-1))));
  }),
);
