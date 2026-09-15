import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { BaseMarkdown } from "./BaseMarkdown";

const MARKDOWN = [
  "# Heading",
  "",
  "- Parent",
  "  - Child",
  "",
  "| Name | Value |",
  "| --- | --- |",
  "| one | 1 |",
  "",
  "![Preview](preview.png)",
  "",
  "```ts",
  "const answer = 42",
  "```",
].join("\n");

describe("BaseMarkdown source positions", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("adds original source ranges to rendered blocks", async () => {
    const mounted = await render(
      <BaseMarkdown
        text={MARKDOWN}
        cwd="/workspace"
        sourceLineMap={[0, ...MARKDOWN.split("\n").map((_line, index) => index + 1)]}
      />,
    );

    try {
      await vi.waitFor(() => expect(document.querySelector("h1")).not.toBeNull());
      const heading = document.querySelector<HTMLElement>("h1")!;
      const listItem = document.querySelector<HTMLElement>("li")!;
      const row = document.querySelector<HTMLElement>("tbody tr")!;
      const image = document.querySelector<HTMLElement>("img")!;

      expect(heading.dataset.sourceStartLine).toBe("1");
      expect(heading.dataset.sourceEndLine).toBe("1");
      expect(listItem.dataset.sourceStartLine).toBe("3");
      expect(listItem.dataset.sourceEndLine).toBe("4");
      expect(row.dataset.sourceStartLine).toBe("8");
      expect(row.dataset.sourceEndLine).toBe("8");
      expect(image.dataset.sourceStartLine).toBe("10");
      expect(image.dataset.sourceEndLine).toBe("10");
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps source metadata off shared markdown callers by default", async () => {
    const mounted = await render(<BaseMarkdown text="# Heading\n\nBody" cwd={undefined} />);

    try {
      expect(document.querySelector("[data-source-start-line]")).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it("omits source metadata when the opt-in map has no entry", async () => {
    const mounted = await render(
      <BaseMarkdown text="# Heading" cwd={undefined} sourceLineMap={[0]} />,
    );

    try {
      await vi.waitFor(() => expect(document.querySelector("h1")).not.toBeNull());
      expect(document.querySelector("h1")?.getAttribute("data-source-start-line")).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});
