import { describe, expect, it } from "vitest";
import {
  BEGIN_SYNCHRONIZED_UPDATE as BSU,
  END_SYNCHRONIZED_UPDATE as ESU,
  openSynchronizedFrameStart,
  synchronizedOutputSafeSplit,
} from "./terminalSynchronizedOutput";

const frame = (body: string) => `${BSU}${body}${ESU}`;

describe("openSynchronizedFrameStart", () => {
  it("finds only a frame that is still open at the end", () => {
    expect(openSynchronizedFrameStart("plain")).toBe(-1);
    expect(openSynchronizedFrameStart(frame("a"))).toBe(-1);
    expect(openSynchronizedFrameStart(`${frame("a")}x${BSU}b`)).toBe(frame("a").length + 1);
  });
});

describe("synchronizedOutputSafeSplit", () => {
  it("keeps data within the limit whole", () => {
    expect(synchronizedOutputSafeSplit("abc", 3)).toBe(3);
  });

  it("splits plain output at the limit", () => {
    expect(synchronizedOutputSafeSplit("abcdef", 4)).toBe(4);
  });

  it("splits before a frame left open at the limit", () => {
    const data = `${frame("one")}text${frame("two-long-body")}`;
    const split = synchronizedOutputSafeSplit(data, data.length - 4);
    expect(data.slice(0, split)).toBe(`${frame("one")}text`);
  });

  it("keeps a leading frame whole up to the hard limit, else splits at the limit", () => {
    const data = `${frame("x".repeat(40))}tail`;
    const frameLength = frame("x".repeat(40)).length;
    expect(synchronizedOutputSafeSplit(data, 20, 100)).toBe(frameLength);
    expect(synchronizedOutputSafeSplit(data, 20, frameLength - 1)).toBe(20);
    expect(synchronizedOutputSafeSplit(`${BSU}${"y".repeat(40)}`, 20, 100)).toBe(20);
  });

  it("treats a begin marker cut by the limit as an open frame", () => {
    const data = `ab${frame("x")}`;
    expect(synchronizedOutputSafeSplit(data, 4)).toBe(2);
    expect(synchronizedOutputSafeSplit(frame("x"), 4, 64)).toBe(frame("x").length);
  });

  it("never splits a surrogate pair", () => {
    const data = `ab\u{1F600}cd`;
    expect(synchronizedOutputSafeSplit(data, 3)).toBe(2);
  });
});
