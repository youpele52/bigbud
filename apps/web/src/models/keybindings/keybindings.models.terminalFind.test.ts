import { assert, describe, it } from "vitest";

import { isTerminalFindShortcut, resolveShortcutCommand } from "./keybindings.models";
import { DEFAULT_BINDINGS, event } from "./keybindings.models.test.helpers";

describe("terminal find shortcut", () => {
  it("routes mod+f to terminal find only while a terminal is focused", () => {
    const keyEvent = event({ key: "f", metaKey: true });
    const focused = { platform: "MacIntel", context: { terminalFocus: true } };
    const unfocused = { platform: "MacIntel", context: { terminalFocus: false } };
    assert.isTrue(isTerminalFindShortcut(keyEvent, DEFAULT_BINDINGS, focused));
    assert.isFalse(isTerminalFindShortcut(keyEvent, DEFAULT_BINDINGS, unfocused));
    assert.strictEqual(
      resolveShortcutCommand(keyEvent, DEFAULT_BINDINGS, focused),
      "terminal.find",
    );
    assert.strictEqual(
      resolveShortcutCommand(keyEvent, DEFAULT_BINDINGS, unfocused),
      "search.toggle",
    );
  });
});
