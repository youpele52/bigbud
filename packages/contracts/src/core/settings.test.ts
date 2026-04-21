import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vitest";

import { ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS } from "./settings";

const decodeClientSettings = Schema.decodeUnknownEffect(ClientSettingsSchema);

describe("DEFAULT_CLIENT_SETTINGS", () => {
  test("defaults terminal appearance settings for client settings", () => {
    expect(DEFAULT_CLIENT_SETTINGS.terminalFontFamily).toBe("meslo-nerd-font-mono");
    expect(DEFAULT_CLIENT_SETTINGS.terminalFontSize).toBe(12);
  });
});

it.effect("decodes valid terminal appearance settings", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeClientSettings({
      terminalFontFamily: "system-monospace",
      terminalFontSize: 14,
    });

    assert.strictEqual(parsed.terminalFontFamily, "system-monospace");
    assert.strictEqual(parsed.terminalFontSize, 14);
  }),
);

it.effect("rejects out-of-range terminal font sizes", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeClientSettings({
        terminalFontFamily: "meslo-nerd-font-mono",
        terminalFontSize: 22,
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);
