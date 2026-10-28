import { describe, expect, it } from "vitest";

import { normalizeKeyChord } from "./keys";

describe("normalizeKeyChord", () => {
  it("normalizes modifier spellings, case and whitespace", () => {
    expect(normalizeKeyChord(" Command + Shift + A ")).toEqual(["cmd", "shift", "a"]);
    expect(normalizeKeyChord("meta+control+c")).toEqual(["cmd", "ctrl", "c"]);
    expect(normalizeKeyChord("Return")).toEqual(["return"]);
  });

  it("drops empty entries, so a lone separator yields no key", () => {
    expect(normalizeKeyChord("cmd++c")).toEqual(["cmd", "c"]);
    expect(normalizeKeyChord("+")).toEqual([]);
    expect(normalizeKeyChord("  ")).toEqual([]);
  });
});
