import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import {
  changeMode,
  createScrollRefs,
  readerScroll,
  readingAnchor,
  SCROLL_CONTENTS,
  ScrollHarness,
  type ScrollRefs,
} from "./FilePreview.scroll.fixtures";
import type { MarkdownFileViewMode } from "./FilePreview.scroll.logic";

function opposite(mode: MarkdownFileViewMode): MarkdownFileViewMode {
  return mode === "raw" ? "preview" : "raw";
}

function expectScrollable(refs: ScrollRefs) {
  const container = refs.container.current!;
  expect(container.clientHeight).toBeGreaterThan(100);
  expect(container.clientHeight).toBeLessThan(260);
  expect(container.scrollHeight - container.clientHeight).toBeGreaterThan(1000);
  expect(container).not.toBe(refs.lines.current);
}

function offsetInViewport(refs: ScrollRefs, element: Element): number {
  return element.getBoundingClientRect().top - refs.container.current!.getBoundingClientRect().top;
}

function rawLineOffset(refs: ScrollRefs, line: number): number {
  return offsetInViewport(refs, refs.lines.current!) + (line - 1) * 20;
}

describe("FilePreview Raw / Preview scroll handoff", () => {
  it.each(["raw", "preview"] as const)(
    "keeps four unchanged round trips from %s within two CSS pixels",
    async (startMode) => {
      const refs = createScrollRefs();
      const mounted = await render(<ScrollHarness refs={refs} />);
      try {
        if (startMode === "raw") await changeMode("raw");
        expectScrollable(refs);
        await readerScroll(refs, startMode === "raw" ? 670 : 970);
        const originalTop = refs.container.current!.scrollTop;
        const originalAnchor = readingAnchor(refs);
        let otherTop: number | undefined;

        for (let cycle = 0; cycle < 4; cycle += 1) {
          await changeMode(opposite(startMode));
          expectScrollable(refs);
          expect(refs.container.current!.scrollTop).toBeGreaterThan(300);
          expect(
            Math.abs(readingAnchor(refs).sourceLine - originalAnchor.sourceLine),
          ).toBeLessThanOrEqual(1);
          otherTop ??= refs.container.current!.scrollTop;
          expect(Math.abs(refs.container.current!.scrollTop - otherTop)).toBeLessThanOrEqual(2);
          await changeMode(startMode);
          expect(Math.abs(refs.container.current!.scrollTop - originalTop)).toBeLessThanOrEqual(2);
        }
      } finally {
        await mounted.unmount();
      }
    },
  );

  it("follows reader movement in each destination instead of reusing the old passage", async () => {
    const refs = createScrollRefs();
    const mounted = await render(<ScrollHarness refs={refs} />);
    try {
      await changeMode("raw");
      await readerScroll(refs, 670);
      const oldAnchor = readingAnchor(refs);
      await changeMode("preview");
      const heading = refs.markdown.current!.querySelectorAll("h2")[23]!;
      await readerScroll(
        refs,
        refs.container.current!.scrollTop + offsetInViewport(refs, heading) + 8,
      );
      const previewAnchor = readingAnchor(refs);
      expect(previewAnchor.sourceLine - oldAnchor.sourceLine).toBeGreaterThan(40);
      await changeMode("raw");
      expect(
        Math.abs(readingAnchor(refs).sourceLine - previewAnchor.sourceLine),
      ).toBeLessThanOrEqual(0.1);
      expect(refs.container.current!.scrollTop).toBeGreaterThan(1500);

      await readerScroll(refs, (71 - 1) * 20 + 8);
      const rawTop = refs.container.current!.scrollTop;
      const rawAnchor = readingAnchor(refs);
      expect(rawAnchor.sourceStartLine).toBe(71);
      await changeMode("preview");
      expect(readingAnchor(refs).sourceStartLine).toBe(71);
      expect(Math.abs(readingAnchor(refs).sourceLine - rawAnchor.sourceLine)).toBeLessThanOrEqual(
        0.1,
      );
      await changeMode("raw");
      expect(Math.abs(refs.container.current!.scrollTop - rawTop)).toBeLessThanOrEqual(2);
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps a known heading boundary at the same viewport offset", async () => {
    const refs = createScrollRefs();
    const mounted = await render(<ScrollHarness refs={refs} />);
    try {
      const heading = refs.markdown.current!.querySelectorAll("h2")[12]!;
      const headingLine = 49;
      expect(SCROLL_CONTENTS.split("\n")[headingLine - 1]).toBe("## Release 13");
      await readerScroll(refs, offsetInViewport(refs, heading) - 12);
      const originalOffset = offsetInViewport(refs, heading);
      expect(readingAnchor(refs).sourceStartLine).toBe(headingLine);
      expect(Math.abs(originalOffset - 12)).toBeLessThanOrEqual(1);
      await changeMode("raw");
      expect(Math.abs(rawLineOffset(refs, headingLine) - originalOffset)).toBeLessThanOrEqual(2);
      await changeMode("preview");
      const restoredHeading = refs.markdown.current!.querySelectorAll("h2")[12]!;
      expect(
        Math.abs(offsetInViewport(refs, restoredHeading) - originalOffset),
      ).toBeLessThanOrEqual(2);

      await changeMode("raw");
      await readerScroll(
        refs,
        refs.container.current!.scrollTop + rawLineOffset(refs, headingLine),
      );
      expect(Math.abs(rawLineOffset(refs, headingLine))).toBeLessThanOrEqual(1);
      await changeMode("preview");
      expect(
        Math.abs(offsetInViewport(refs, refs.markdown.current!.querySelectorAll("h2")[12]!)),
      ).toBeLessThanOrEqual(2);
    } finally {
      await mounted.unmount();
    }
  });

  it.each(["raw", "preview"] as const)("preserves top and bottom from %s", async (startMode) => {
    const refs = createScrollRefs();
    const mounted = await render(<ScrollHarness refs={refs} />);
    try {
      if (startMode === "raw") await changeMode("raw");
      expectScrollable(refs);
      await readerScroll(refs, 400);
      await readerScroll(refs, 0);
      await changeMode(opposite(startMode));
      expect(refs.container.current!.scrollTop).toBe(0);
      await changeMode(startMode);
      expect(refs.container.current!.scrollTop).toBe(0);

      await readerScroll(refs, Number.MAX_SAFE_INTEGER);
      for (const mode of [opposite(startMode), startMode]) {
        await changeMode(mode);
        const container = refs.container.current!;
        expectScrollable(refs);
        expect(container.scrollTop).toBeGreaterThan(1000);
        expect(
          Math.abs(container.scrollTop - (container.scrollHeight - container.clientHeight)),
        ).toBeLessThanOrEqual(1);
      }
    } finally {
      await mounted.unmount();
    }
  });

  it.each(["", "# Short\n\nA short paragraph."])(
    "keeps a non-scrollable document at zero (%j)",
    async (contents) => {
      const refs = createScrollRefs();
      const mounted = await render(<ScrollHarness refs={refs} contents={contents} />);
      try {
        for (const mode of ["raw", "preview", "raw", "preview"] as const) {
          await changeMode(mode);
          const container = refs.container.current!;
          expect(container.clientHeight).toBeGreaterThan(100);
          expect(container.scrollHeight).toBeLessThanOrEqual(container.clientHeight);
          container.scrollTop = 400;
          expect(container.scrollTop).toBe(0);
        }
      } finally {
        await mounted.unmount();
      }
    },
  );

  it("keeps wrapped parent text and later child text on their respective source lines", async () => {
    const before = Array.from({ length: 16 }, (_, index) => `Paragraph ${index}.\n`).join("\n");
    const label =
      "A long wrapped parent label should remain separate from its compact child items. ";
    const contents = `${before}\n- **Parent** ${label.repeat(10)}\n  - Child one\n  - Child two\n  - Child three\n\n${before}`;
    const parentLine =
      contents.split("\n").findIndex((line) => line.startsWith("- **Parent**")) + 1;
    const refs = createScrollRefs();
    const mounted = await render(<ScrollHarness refs={refs} contents={contents} width={360} />);
    try {
      expectScrollable(refs);
      const parent = refs.markdown.current!.querySelector("li")!;
      const nested = parent.querySelector("ul")!;
      const range = document.createRange();
      range.setStart(parent, 0);
      range.setEndBefore(nested);
      const ownText = range.getBoundingClientRect();
      expect(ownText.height).toBeGreaterThan(220);
      await readerScroll(
        refs,
        ownText.top - refs.container.current!.getBoundingClientRect().top + ownText.height * 0.65,
      );
      const originalTop = refs.container.current!.scrollTop;
      expect(readingAnchor(refs, contents).sourceStartLine).toBe(parentLine);
      await changeMode("raw");
      expect(readingAnchor(refs, contents).sourceStartLine).toBe(parentLine);
      await changeMode("preview");
      expect(Math.abs(refs.container.current!.scrollTop - originalTop)).toBeLessThanOrEqual(2);

      const child = refs.markdown.current!.querySelectorAll("li ul li")[1]!;
      await readerScroll(
        refs,
        refs.container.current!.scrollTop + offsetInViewport(refs, child) + 8,
      );
      expect(readingAnchor(refs, contents).sourceStartLine).toBe(parentLine + 2);
      await changeMode("raw");
      expect(readingAnchor(refs, contents).sourceStartLine).toBe(parentLine + 2);
    } finally {
      await mounted.unmount();
    }
  });

  it("accounts for the Raw truncation banner in both directions", async () => {
    const refs = createScrollRefs();
    const mounted = await render(<ScrollHarness refs={refs} truncated />);
    try {
      const heading = refs.markdown.current!.querySelectorAll("h2")[12]!;
      await readerScroll(refs, Math.ceil(offsetInViewport(refs, heading)));
      const previewTop = refs.container.current!.scrollTop;
      await changeMode("raw");
      const container = refs.container.current!;
      const banner = container.firstElementChild!;
      expect(banner.textContent).toBe("Preview truncated.");
      const bannerHeight = banner.getBoundingClientRect().height;
      expect(bannerHeight).toBeGreaterThan(20);
      expect(Math.abs(rawLineOffset(refs, 49))).toBeLessThanOrEqual(2);
      await changeMode("preview");
      expect(Math.abs(refs.container.current!.scrollTop - previewTop)).toBeLessThanOrEqual(2);

      await changeMode("raw");
      await readerScroll(refs, bannerHeight + (75 - 1) * 20 + 7);
      const rawTop = refs.container.current!.scrollTop;
      const rawAnchor = readingAnchor(refs);
      expect(rawAnchor.sourceStartLine).toBe(75);
      expect(Math.abs(rawAnchor.sourceLine - 75.35)).toBeLessThanOrEqual(0.05);
      await changeMode("preview");
      expect(readingAnchor(refs).sourceStartLine).toBe(75);
      expect(Math.abs(readingAnchor(refs).sourceLine - rawAnchor.sourceLine)).toBeLessThanOrEqual(
        0.1,
      );
      await changeMode("raw");
      expect(Math.abs(refs.container.current!.scrollTop - rawTop)).toBeLessThanOrEqual(2);
    } finally {
      await mounted.unmount();
    }
  });
});
