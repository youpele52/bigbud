import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import {
  changeMode,
  createScrollRefs,
  readerScroll,
  readingAnchor,
  SCROLL_CONTENTS,
  ScrollHarness,
} from "./FilePreview.scroll.fixtures";

describe("FilePreview source matching", () => {
  it("keeps the final line of a multiline paragraph visible at its relative position", async () => {
    const contents = `${SCROLL_CONTENTS}\n\nFirst paragraph line\nSecond paragraph line\nFinal paragraph line\n\n${SCROLL_CONTENTS}`;
    const refs = createScrollRefs();
    const mounted = await render(<ScrollHarness refs={refs} contents={contents} />);
    try {
      const sourceLine = contents.split("\n").indexOf("Final paragraph line") + 1;
      await changeMode("raw");
      const rawTop = (sourceLine - 1) * 20 + 10;
      await readerScroll(refs, rawTop);
      expect(readingAnchor(refs, contents).sourceLine).toBe(sourceLine + 0.5);
      await changeMode("preview");
      const paragraph = refs.markdown.current!.querySelector<HTMLParagraphElement>(
        `p[data-source-end-line="${sourceLine}"]`,
      )!;
      const bounds = paragraph.getBoundingClientRect();
      const viewport = refs.container.current!.getBoundingClientRect();
      expect(bounds.bottom - viewport.top).toBeGreaterThan(2);
      expect(bounds.top - viewport.top).toBeLessThan(0);
      expect(Math.abs(viewport.top - bounds.top - bounds.height * (2.5 / 3))).toBeLessThanOrEqual(
        2,
      );
      expect(Math.abs(readingAnchor(refs, contents).sourceLine - sourceLine - 0.5)).toBeLessThan(
        0.1,
      );
      await changeMode("raw");
      expect(Math.abs(refs.container.current!.scrollTop - rawTop)).toBeLessThanOrEqual(2);
    } finally {
      await mounted.unmount();
    }
  });

  it("distinguishes duplicate headings, paragraphs and blockquotes by original source lines", async () => {
    const contents = Array.from(
      { length: 30 },
      () => "## Same heading\n\nIdentical paragraph.\n\n> Repeated quotation.\n\n",
    ).join("");
    const refs = createScrollRefs();
    const mounted = await render(<ScrollHarness refs={refs} contents={contents} />);
    try {
      const paragraph =
        refs.markdown.current!.querySelectorAll<HTMLParagraphElement>("blockquote p")[15]!;
      const source = Number(paragraph.dataset.sourceStartLine);
      const container = refs.container.current!;
      await readerScroll(
        refs,
        paragraph.getBoundingClientRect().top - container.getBoundingClientRect().top,
      );
      expect(source).toBeGreaterThan(70);
      expect(readingAnchor(refs, contents).sourceStartLine).toBe(source);
      const top = container.scrollTop;
      await changeMode("raw");
      expect(Math.floor(readingAnchor(refs, contents).sourceLine)).toBe(source);
      await changeMode("preview");
      expect(Math.abs(refs.container.current!.scrollTop - top)).toBeLessThanOrEqual(2);
    } finally {
      await mounted.unmount();
    }
  });

  it("uses a finite relative fallback when source metadata is missing", async () => {
    const refs = createScrollRefs();
    const mounted = await render(<ScrollHarness refs={refs} />);
    try {
      const container = refs.container.current!;
      await readerScroll(refs, (container.scrollHeight - container.clientHeight) * 0.4);
      const fraction = container.scrollTop / (container.scrollHeight - container.clientHeight);
      for (const element of refs.markdown.current!.querySelectorAll("[data-source-start-line]")) {
        element.removeAttribute("data-source-start-line");
        element.removeAttribute("data-source-end-line");
      }
      expect(readingAnchor(refs).sourceAvailable).toBe(false);
      await changeMode("raw");
      const raw = refs.container.current!;
      expect(raw.scrollTop).toBeGreaterThan(0);
      expect(
        Math.abs(raw.scrollTop - fraction * (raw.scrollHeight - raw.clientHeight)),
      ).toBeLessThanOrEqual(1);
      await changeMode("preview");
      expect(readingAnchor(refs, SCROLL_CONTENTS).sourceLine).toBeGreaterThan(1);
    } finally {
      await mounted.unmount();
    }
  });
});
