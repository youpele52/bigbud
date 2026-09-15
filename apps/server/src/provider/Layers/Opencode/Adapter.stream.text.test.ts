import { describe, expect, it } from "vitest";

import { makeOpencodeTextStream } from "./Adapter.stream.text.ts";

describe("OpenCode shared text delivery", () => {
  it("emits live fragments once when polling repeats or lags behind them", () => {
    const stream = makeOpencodeTextStream();
    expect(stream.delta("text", "hello")).toBe("hello");
    expect(stream.snapshot("text", "hel")).toBe("");
    expect(stream.snapshot("text", "hello")).toBe("");
    expect(stream.delta("text", " world")).toBe(" world");
    expect(stream.snapshot("text", "hello world")).toBe("");
  });

  it("uses snapshots once polling overtakes queued live delivery", () => {
    const stream = makeOpencodeTextStream();
    expect(stream.delta("text", "ab")).toBe("ab");
    expect(stream.snapshot("text", "abcd")).toBe("cd");
    expect(stream.delta("text", "cd")).toBe("");
    expect(stream.delta("text", "ef")).toBe("");
    expect(stream.snapshot("text", "abcdef")).toBe("ef");
    expect(stream.snapshot("text", "abcdef")).toBe("");
  });

  it("does not confuse legitimate repeated text with duplicate delivery", () => {
    const stream = makeOpencodeTextStream();
    expect(stream.delta("text", "ha")).toBe("ha");
    expect(stream.delta("text", "ha")).toBe("ha");
    expect(stream.snapshot("text", "haha")).toBe("");
    expect(stream.snapshot("text", "hahaha")).toBe("ha");
  });

  it("keeps assistant, reasoning, and separate message parts independent", () => {
    const stream = makeOpencodeTextStream();
    expect(stream.snapshot("reasoning", "think")).toBe("think");
    expect(stream.delta("reasoning", "think")).toBe("");
    expect(stream.delta("assistant-1", "think")).toBe("think");
    expect(stream.snapshot("assistant-1", "think")).toBe("");
    expect(stream.snapshot("assistant-2", "think")).toBe("think");
  });

  it("does not reset delivered text when snapshots are stale or inconsistent", () => {
    const stream = makeOpencodeTextStream();
    expect(stream.snapshot("text", "hello")).toBe("hello");
    expect(stream.snapshot("text", "he")).toBe("");
    expect(stream.snapshot("text", "unrelated")).toBe("");
    expect(stream.snapshot("text", "hello world")).toBe(" world");
  });

  it("recovers missed fragments from snapshots after a disconnect", () => {
    const stream = makeOpencodeTextStream();
    expect(stream.delta("text", "ab")).toBe("ab");
    stream.invalidateLive();
    // cd was lost during the disconnect, so appending ef would corrupt the text.
    expect(stream.delta("text", "ef")).toBe("");
    expect(stream.delta("new-part", "tail")).toBe("");
    expect(stream.snapshot("text", "abcdef")).toBe("cdef");
    expect(stream.snapshot("new-part", "head-tail")).toBe("head-tail");
  });
});
