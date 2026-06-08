import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { ResolvedKeybindingFromConfig, compileResolvedKeybindingRule } from "./keybindings";

it.effect("compiles valid rule with parsed when AST", () =>
  Effect.sync(() => {
    const compiled = compileResolvedKeybindingRule({
      key: "mod+d",
      command: "terminal.split",
      when: "terminalOpen && !terminalFocus",
    });

    assert.deepEqual(compiled, {
      command: "terminal.split",
      shortcut: {
        key: "d",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      },
      whenAst: {
        type: "and",
        left: { type: "identifier", name: "terminalOpen" },
        right: {
          type: "not",
          node: { type: "identifier", name: "terminalFocus" },
        },
      },
    });
  }),
);

it.effect("encodes resolved plus-key shortcuts", () =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(ResolvedKeybindingFromConfig)({
      command: "terminal.toggle",
      shortcut: {
        key: "+",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      },
    });

    assert.equal(encoded.key, "mod++");
    assert.equal(encoded.command, "terminal.toggle");
  }),
);

it.effect("rejects invalid rules", () =>
  Effect.sync(() => {
    assert.isNull(
      compileResolvedKeybindingRule({
        key: "mod+shift+d+o",
        command: "terminal.new",
      }),
    );

    assert.isNull(
      compileResolvedKeybindingRule({
        key: "mod+d",
        command: "terminal.split",
        when: "terminalFocus && (",
      }),
    );

    assert.isNull(
      compileResolvedKeybindingRule({
        key: "mod+d",
        command: "terminal.split",
        when: `${"!".repeat(300)}terminalFocus`,
      }),
    );
  }),
);
