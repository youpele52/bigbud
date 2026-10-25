import type { IUnicodeVersionProvider } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { activateTerminalUnicodeProvider } from "./terminalUnicodeProvider";

const properties = (kind: number, width: number, join = false) =>
  ((kind & 0xffffff) << 3) | ((width & 3) << 1) | (join ? 1 : 0);

function fakeTerminal(base?: IUnicodeVersionProvider) {
  const registered: IUnicodeVersionProvider[] = [];
  const unicode = {
    activeVersion: "6",
    versions: ["6", "11"],
    register: vi.fn((provider: IUnicodeVersionProvider) => {
      registered.push(provider);
      unicode.versions.push(provider.version);
    }),
  };
  return {
    terminal: { unicode, _core: base ? { unicodeService: { _providers: { "11": base } } } : {} },
    registered,
  };
}

describe("activateTerminalUnicodeProvider", () => {
  it("joins a ZWJ sequence into the width of its first emoji", () => {
    const base: IUnicodeVersionProvider = {
      version: "11",
      wcwidth: (codepoint) => (codepoint === 0x200d ? 0 : 2),
      charProperties: (codepoint) => properties(codepoint, codepoint === 0x200d ? 0 : 2),
    };
    const { terminal, registered } = fakeTerminal(base);
    activateTerminalUnicodeProvider(terminal as never);
    activateTerminalUnicodeProvider(terminal as never);
    expect(terminal.unicode.register).toHaveBeenCalledOnce();
    const provider = registered[0]!;
    expect(terminal.unicode.activeVersion).toBe(provider.version);
    const man = provider.charProperties(0x1f468, 0);
    const zwj = provider.charProperties(0x200d, man);
    expect(zwj & 1).toBe(1);
    const woman = provider.charProperties(0x1f469, zwj);
    // Joined to the previous cluster at the first emoji's width instead of advancing two cells.
    expect(woman & 1).toBe(1);
    expect((woman >> 1) & 3).toBe(2);
  });

  it("falls back to plain Unicode 11 without the private provider registry", () => {
    const { terminal } = fakeTerminal();
    activateTerminalUnicodeProvider(terminal as never);
    expect(terminal.unicode.activeVersion).toBe("11");
    expect(terminal.unicode.register).not.toHaveBeenCalled();
  });
});
