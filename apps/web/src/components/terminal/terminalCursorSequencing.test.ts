import { describe, expect, it } from "vitest";
import { removeTransientCursorShowSequences } from "./terminalCursorSequencing";

const SHOW = "\x1b[?25h";
const HIDE = "\x1b[?25l";
const ESU = "\x1b[?2026l";

describe("removeTransientCursorShowSequences", () => {
  it("leaves output without cursor shows untouched", () => {
    expect(removeTransientCursorShowSequences("plain \x1b[1;1H text")).toBe("plain \x1b[1;1H text");
  });

  it("drops a show that is immediately hidden again", () => {
    expect(removeTransientCursorShowSequences(`a${SHOW}b${HIDE}c`)).toBe(`ab${HIDE}c`);
  });

  it("moves a show after the following cursor placement", () => {
    expect(removeTransientCursorShowSequences(`${SHOW}\x1b[5;10Hx`)).toBe(`\x1b[5;10H${SHOW}x`);
  });

  it("keeps the cursor hidden until a synchronized frame ends", () => {
    expect(removeTransientCursorShowSequences(`${SHOW}draw${ESU}after`)).toBe(
      `draw${ESU}${SHOW}after`,
    );
  });

  it("keeps a final show with nothing after it", () => {
    expect(removeTransientCursorShowSequences(`text${SHOW}`)).toBe(`text${SHOW}`);
  });
});
