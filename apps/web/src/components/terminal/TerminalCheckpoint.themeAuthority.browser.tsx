import { Terminal } from "@xterm/xterm";
import { expect, it } from "vitest";
import { attachTerminalAddons } from "./TerminalViewport.addons";

const queryBackground = "\x1b]11;?\x1b\\";
const write = (terminal: Terminal, data: string) =>
  new Promise<void>((resolve) => terminal.write(data, resolve));

it("production views answer the same query differently and change replies after a live theme update", async () => {
  const first = new Terminal({ allowProposedApi: true, theme: { background: "#112233" } });
  const second = new Terminal({ allowProposedApi: true, theme: { background: "#aabbcc" } });
  const mounts = [document.createElement("div"), document.createElement("div")];
  mounts.forEach((mount) => document.body.append(mount));
  first.open(mounts[0]!);
  second.open(mounts[1]!);
  const addons = [first, second].map((terminal) =>
    attachTerminalAddons(terminal, {
      onGlyphShapingChanged: () => undefined,
    }),
  );
  const firstReplies: string[] = [];
  const secondReplies: string[] = [];
  first.onData((data) => firstReplies.push(data));
  second.onData((data) => secondReplies.push(data));
  try {
    expect(first.unicode.activeVersion).toBe("bigbud-11-zwj");
    await write(first, queryBackground);
    await write(second, queryBackground);
    expect(firstReplies).toEqual(["\x1b]11;rgb:1111/2222/3333\x1b\\"]);
    expect(secondReplies).toEqual(["\x1b]11;rgb:aaaa/bbbb/cccc\x1b\\"]);
    first.options.theme = { background: "#aabbcc" };
    await write(first, queryBackground);
    expect(firstReplies[1]).toBe(secondReplies[0]);
    // Application palette state also affects the answer, separately from the user theme.
    await write(first, "\x1b]11;#445566\x1b\\" + queryBackground);
    expect(firstReplies[2]).toBe("\x1b]11;rgb:4444/5555/6666\x1b\\");
  } finally {
    addons.forEach((addon) => addon.dispose());
    first.dispose();
    second.dispose();
    mounts.forEach((mount) => mount.remove());
  }
});
