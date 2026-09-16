import { describe, expect, it } from "vitest";

import {
  captureMarkdownReadingAnchor,
  captureRawReadingAnchor,
  resolveMarkdownScrollTop,
  resolveRawScrollTop,
  type ScrollMetrics,
  type SourceBlockMeasurement,
} from "./FilePreview.scroll.logic";

const metrics = (scrollTop: number): ScrollMetrics => ({
  scrollTop,
  clientHeight: 100,
  scrollHeight: 500,
});

const block = (
  startLine: number,
  endLine: number,
  top: number,
  height: number,
  depth = 0,
): SourceBlockMeasurement => ({ startLine, endLine, top, height, depth });

describe("FilePreview scroll anchors", () => {
  it("maps raw lines through content above the line container", () => {
    const anchor = captureRawReadingAnchor({
      metrics: metrics(40),
      linesTop: -40,
      lineHeight: 20,
      totalLines: 100,
    });

    expect(anchor.sourceLine).toBe(3);
    expect(resolveRawScrollTop(anchor, metrics(0), 0, 20)).toBe(40);
  });

  it("preserves a fractional position inside a rendered block", () => {
    const anchor = captureMarkdownReadingAnchor({
      metrics: metrics(100),
      blocks: [block(10, 20, -50, 100)],
    });

    expect(anchor.sourceLine).toBe(15.5);
    expect(anchor.sourceProgress).toBe(0.5);
    expect(resolveMarkdownScrollTop(anchor, metrics(0), [block(10, 20, 0, 200)])).toBe(100);
  });

  it("preserves fractional progress inside a single-source-line block", () => {
    const anchor = captureMarkdownReadingAnchor({
      metrics: metrics(100),
      blocks: [block(10, 10, -25, 100)],
    });

    expect(anchor.sourceLine).toBe(10.25);
    expect(anchor.sourceProgress).toBe(0.25);
  });

  it("prefers the narrowest and deepest block at the viewport edge", () => {
    const anchor = captureMarkdownReadingAnchor({
      metrics: metrics(100),
      blocks: [block(3, 12, -20, 100), block(5, 8, -20, 100, 1)],
    });

    expect(anchor.sourceStartLine).toBe(5);
    expect(anchor.sourceEndLine).toBe(8);
  });

  it("uses the next or previous block when the viewport edge is whitespace", () => {
    const following = captureMarkdownReadingAnchor({
      metrics: metrics(100),
      blocks: [block(20, 20, 24, 30), block(30, 30, 80, 30)],
    });
    expect(following.sourceLine).toBe(20);
    expect(following.viewportOffset).toBe(24);

    const previous = captureMarkdownReadingAnchor({
      metrics: metrics(100),
      blocks: [block(10, 10, -40, 30), block(20, 20, -5, 2)],
    });
    expect(previous.sourceLine).toBe(21);
    expect(previous.viewportOffset).toBe(-3);
  });

  it("keeps top and bottom boundaries stable and clamps the result", () => {
    const top = captureRawReadingAnchor({
      metrics: metrics(0),
      linesTop: 12,
      lineHeight: 20,
      totalLines: 100,
    });
    expect(resolveRawScrollTop(top, metrics(200), 0, 20)).toBe(0);

    const bottom = captureRawReadingAnchor({
      metrics: metrics(400),
      linesTop: -400,
      lineHeight: 20,
      totalLines: 100,
    });
    expect(resolveRawScrollTop(bottom, metrics(0), 0, 20)).toBe(400);

    const short = captureMarkdownReadingAnchor({ metrics: metrics(0), blocks: [] });
    expect(resolveMarkdownScrollTop(short, metrics(0), [])).toBe(0);
  });

  it("falls back to relative position when destination metadata is unavailable", () => {
    const anchor = captureMarkdownReadingAnchor({
      metrics: metrics(150),
      blocks: [],
    });

    expect(anchor.scrollFraction).toBe(0.375);
    expect(resolveMarkdownScrollTop(anchor, metrics(0), [])).toBe(150);
    expect(resolveRawScrollTop(anchor, metrics(0), 0, 20)).toBe(150);
  });

  it("keeps the fractional last source line within its rendered block", () => {
    const anchor = captureRawReadingAnchor({
      metrics: metrics(190),
      linesTop: -190,
      lineHeight: 20,
      totalLines: 30,
    });
    expect(anchor.sourceLine).toBe(10.5);
    expect(
      resolveMarkdownScrollTop(anchor, metrics(0), [block(5, 10, 40, 80), block(12, 12, 160, 30)]),
    ).toBeCloseTo(40 + (5.5 / 6) * 80);
  });
});
