import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import {
  animationFrames,
  changeMode,
  createScrollRefs,
  readerScroll,
  ScrollHarness,
} from "./FilePreview.scroll.fixtures";

const highlighterGate = vi.hoisted(() => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
});

vi.mock("@pierre/diffs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pierre/diffs")>();
  return {
    ...actual,
    getSharedHighlighter: vi.fn(
      async (options: Parameters<typeof actual.getSharedHighlighter>[0]) => {
        await highlighterGate.promise;
        return actual.getSharedHighlighter(options);
      },
    ),
  };
});

describe("FilePreview delayed Raw highlighting", () => {
  it("keeps a nonzero handoff through the real fallback-to-Shiki replacement", async () => {
    const refs = createScrollRefs();
    const positions = vi.fn();
    const mounted = await render(
      <ScrollHarness refs={refs} plainText={false} onPosition={positions} />,
    );
    try {
      await changeMode("raw");
      await readerScroll(refs, 670);
      await changeMode("preview");
      await changeMode("raw");
      expect(refs.code.current!.querySelector(".chat-markdown-shiki")).toBeNull();
      expect(refs.code.current!.querySelector("pre")).not.toBeNull();
      expect(refs.container.current!.scrollTop).toBe(670);
      await new Promise((resolve) => setTimeout(resolve, 800));
      highlighterGate.release();
      await vi.waitFor(
        () => expect(refs.code.current!.querySelector(".chat-markdown-shiki")).not.toBeNull(),
        { timeout: 5000 },
      );
      expect(
        refs.code.current!.querySelectorAll(".chat-markdown-shiki span[style]").length,
      ).toBeGreaterThan(0);
      await animationFrames();
      expect(Math.abs(refs.container.current!.scrollTop - 670)).toBeLessThanOrEqual(2);
      await vi.waitFor(() =>
        expect(positions).toHaveBeenLastCalledWith(refs.container.current!.scrollTop),
      );
      await changeMode("preview");
      await changeMode("raw");
      expect(Math.abs(refs.container.current!.scrollTop - 670)).toBeLessThanOrEqual(2);
    } finally {
      highlighterGate.release();
      await mounted.unmount();
    }
  });
});
