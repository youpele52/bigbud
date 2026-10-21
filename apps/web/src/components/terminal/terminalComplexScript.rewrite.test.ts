// Ported from Orca (stablyai/orca, MIT) src/renderer/src/lib/pane-manager/terminal-complex-script.test.ts at be4e0719.
import { describe, expect, it } from "vitest";
import {
  nativeWindowsRewriteNeedsFollowupRenderRefresh,
  terminalRewriteOutputRenderRefreshDecision,
  terminalRewriteOutputPrefersRenderRefresh,
  type TerminalRewriteOutputRenderRefreshState,
} from "./terminalComplexScript";

describe("terminalRewriteOutputPrefersRenderRefresh", () => {
  it("detects in-place carriage-return redraws", () => {
    expect(terminalRewriteOutputPrefersRenderRefresh("\r• Working")).toBe(true);
    expect(terminalRewriteOutputPrefersRenderRefresh("prefix\r\x1b[2K• Working")).toBe(true);
  });

  it("does not treat normal CRLF output as an in-place redraw", () => {
    expect(terminalRewriteOutputPrefersRenderRefresh("line one\r\nline two\r\n")).toBe(false);
  });

  it("waits on a trailing carriage return so split CRLF output does not refresh early", () => {
    expect(terminalRewriteOutputPrefersRenderRefresh("line one\r")).toBe(false);
    expect(terminalRewriteOutputPrefersRenderRefresh("\nline two")).toBe(false);
  });

  it("detects terminal erase rewrites and backspace updates", () => {
    expect(terminalRewriteOutputPrefersRenderRefresh("\x1b[2K• Working")).toBe(true);
    expect(terminalRewriteOutputPrefersRenderRefresh("\x1b[2J\x1b[Hredraw")).toBe(true);
    expect(terminalRewriteOutputPrefersRenderRefresh("progress 10%\b\b20%")).toBe(true);
  });

  it("still detects split Codex-style rewrites through the erase-line chunk", () => {
    expect(terminalRewriteOutputPrefersRenderRefresh("\r")).toBe(false);
    expect(terminalRewriteOutputPrefersRenderRefresh("\x1b[2K• Working")).toBe(true);
  });

  it("ignores ordinary cursor movement and style output", () => {
    expect(terminalRewriteOutputPrefersRenderRefresh("\x1b[10;2Hcursor move")).toBe(false);
    expect(terminalRewriteOutputPrefersRenderRefresh("\x1b[32mplain green\x1b[0m")).toBe(false);
  });
});

describe("terminalRewriteOutputRenderRefreshDecision", () => {
  it("refreshes when a trailing carriage return continues as a split redraw", () => {
    const trailingCarriageReturn = terminalRewriteOutputRenderRefreshDecision("\r", {
      previousChunkEndsWithCarriageReturn: false,
      previousRewriteCsiScanTail: "",
    });
    expect(trailingCarriageReturn).toEqual({
      nextChunkEndsWithCarriageReturn: true,
      nextRewriteCsiScanTail: "",
      prefersRenderRefresh: false,
    });

    expect(
      terminalRewriteOutputRenderRefreshDecision("• Working without erase-line", {
        previousChunkEndsWithCarriageReturn: true,
        previousRewriteCsiScanTail: "",
      }),
    ).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: "",
      prefersRenderRefresh: true,
    });
  });

  it("does not refresh split CRLF output", () => {
    const trailingCarriageReturn = terminalRewriteOutputRenderRefreshDecision("line one\r", {
      previousChunkEndsWithCarriageReturn: false,
      previousRewriteCsiScanTail: "",
    });
    expect(trailingCarriageReturn).toEqual({
      nextChunkEndsWithCarriageReturn: true,
      nextRewriteCsiScanTail: "",
      prefersRenderRefresh: false,
    });

    expect(
      terminalRewriteOutputRenderRefreshDecision("\nline two", {
        previousChunkEndsWithCarriageReturn: true,
        previousRewriteCsiScanTail: "",
      }),
    ).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: "",
      prefersRenderRefresh: false,
    });
  });

  it("refreshes when a rewrite erase sequence is split across chunks", () => {
    const trailingRewriteCsi = terminalRewriteOutputRenderRefreshDecision("\r\x1b[", {
      previousChunkEndsWithCarriageReturn: false,
      previousRewriteCsiScanTail: "",
    });
    expect(trailingRewriteCsi).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: "\x1b[",
      prefersRenderRefresh: true,
    });

    expect(
      terminalRewriteOutputRenderRefreshDecision("2K• Working", {
        previousChunkEndsWithCarriageReturn: false,
        previousRewriteCsiScanTail: "\x1b[",
      }),
    ).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: "",
      prefersRenderRefresh: true,
    });
  });

  it("carries rewrite erase sequence tails split before CSI introducer or params", () => {
    expect(
      terminalRewriteOutputRenderRefreshDecision("\x1b", {
        previousChunkEndsWithCarriageReturn: false,
        previousRewriteCsiScanTail: "",
      }),
    ).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: "\x1b",
      prefersRenderRefresh: false,
    });

    expect(
      terminalRewriteOutputRenderRefreshDecision("2J", {
        previousChunkEndsWithCarriageReturn: false,
        previousRewriteCsiScanTail: "\x1b[",
      }),
    ).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: "",
      prefersRenderRefresh: true,
    });
  });

  it("drops overlong rewrite CSI tails", () => {
    expect(
      terminalRewriteOutputRenderRefreshDecision(`\x1b[${"1".repeat(80)}`, {
        previousChunkEndsWithCarriageReturn: false,
        previousRewriteCsiScanTail: "",
      }),
    ).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: "",
      prefersRenderRefresh: false,
    });
  });

  it("preserves pending trailing carriage return state across empty chunks", () => {
    expect(
      terminalRewriteOutputRenderRefreshDecision("", {
        previousChunkEndsWithCarriageReturn: true,
        previousRewriteCsiScanTail: "\x1b[",
      }),
    ).toEqual({
      nextChunkEndsWithCarriageReturn: true,
      nextRewriteCsiScanTail: "\x1b[",
      prefersRenderRefresh: false,
    });
  });
});

describe("nativeWindowsRewriteNeedsFollowupRenderRefresh", () => {
  // Why: Claude Code (issue #5656/#5653) echoes prompt keystrokes by redrawing
  // the input line in place with CR + CHA + reprint + erase-line, split across
  // ConPTY chunks, and WITHOUT DEC 2026 synchronized output. Replay that exact
  // pattern through the rewrite decision and assert that on native Windows it
  // requests a follow-up next-frame repaint, which is what stops the phantom /
  // overwritten characters without the user resizing the window.
  function rewriteIsInPlace(chunks: string[]): boolean[] {
    const state: TerminalRewriteOutputRenderRefreshState = {
      previousChunkEndsWithCarriageReturn: false,
      previousRewriteCsiScanTail: "",
    };
    return chunks.map((chunk) => {
      const decision = terminalRewriteOutputRenderRefreshDecision(chunk, state);
      state.previousChunkEndsWithCarriageReturn = decision.nextChunkEndsWithCarriageReturn;
      state.previousRewriteCsiScanTail = decision.nextRewriteCsiScanTail;
      return decision.prefersRenderRefresh;
    });
  }

  it("schedules a follow-up repaint for the split Claude prompt redraw on native Windows", () => {
    // "> " prompt, then user types z, z, z, x — each keystroke redraws in place.
    const claudeRedrawChunks = [
      "\r\x1b[3G",
      "z\x1b[K",
      "\r\x1b[3G",
      "zz\x1b[K",
      "\r\x1b[3G",
      "zzz\x1b[K",
      "\r\x1b[3G",
      "zzzx\x1b[K",
    ];
    const inPlace = rewriteIsInPlace(claudeRedrawChunks);
    // Every redraw chunk is an in-place rewrite (CR continuation or erase-line).
    expect(inPlace.every(Boolean)).toBe(true);
    for (const isInPlaceRewrite of inPlace) {
      expect(
        nativeWindowsRewriteNeedsFollowupRenderRefresh({
          isNativeWindowsConpty: true,
          isForeground: true,
          isInPlaceRewrite,
        }),
      ).toBe(true);
    }
  });

  it("does not schedule a follow-up repaint for ordinary CRLF foreground output", () => {
    const inPlace = rewriteIsInPlace(["line one\r\n", "line two\r\n"]);
    expect(inPlace).toEqual([false, false]);
    for (const isInPlaceRewrite of inPlace) {
      expect(
        nativeWindowsRewriteNeedsFollowupRenderRefresh({
          isNativeWindowsConpty: true,
          isForeground: true,
          isInPlaceRewrite,
        }),
      ).toBe(false);
    }
  });

  it("stays off for non-Windows renderers and background writes", () => {
    expect(
      nativeWindowsRewriteNeedsFollowupRenderRefresh({
        isNativeWindowsConpty: false,
        isForeground: true,
        isInPlaceRewrite: true,
      }),
    ).toBe(false);
    expect(
      nativeWindowsRewriteNeedsFollowupRenderRefresh({
        isNativeWindowsConpty: true,
        isForeground: false,
        isInPlaceRewrite: true,
      }),
    ).toBe(false);
  });
});
