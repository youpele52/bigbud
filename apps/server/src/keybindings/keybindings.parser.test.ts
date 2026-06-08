import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { parseKeybindingShortcut } from "./keybindings.parser";

it.effect("parses shortcuts including plus key", () =>
  Effect.sync(() => {
    assert.deepEqual(parseKeybindingShortcut("mod+j"), {
      key: "j",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    });
    assert.deepEqual(parseKeybindingShortcut("mod++"), {
      key: "+",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    });
  }),
);
