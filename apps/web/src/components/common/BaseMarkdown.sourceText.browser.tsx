import "../../index.css";

import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { BaseMarkdown } from "./BaseMarkdown";

const CONTENTS = [
  "## Section boundary",
  "",
  "| Name | Details |",
  "| --- | --- |",
  `| Small | ${"Wrapped table cell content. ".repeat(15)} |`,
  "| Next | Brief |",
  "",
  "```text",
  "first line",
  "second line",
  "```",
].join("\n");
const SOURCE_LINES = [0, ...CONTENTS.split("\n").map((_line, index) => index + 1)];

function MarkdownLayoutFixture({ metadata }: { metadata: boolean }) {
  return (
    <div style={{ width: 360, height: 220 }}>
      <div className="p-3">
        <BaseMarkdown
          text={CONTENTS}
          cwd="/workspace"
          preserveLineBreaks
          sourceLineMap={metadata ? SOURCE_LINES : undefined}
        />
      </div>
    </div>
  );
}

describe("Markdown source text metadata layout", () => {
  it("preserves table geometry compared with rendering without source metadata", async () => {
    const mounted = await render(<MarkdownLayoutFixture metadata={false} />);
    try {
      const baseline = document.querySelector("tbody tr")!.getBoundingClientRect();
      expect(document.querySelector("[data-source-text-line]")).toBeNull();
      await mounted.rerender(<MarkdownLayoutFixture metadata />);
      expect(document.querySelector("[data-source-text-line]")).not.toBeNull();
      const withMetadata = document.querySelector("tbody tr")!.getBoundingClientRect();
      expect(withMetadata.height).toBe(baseline.height);
      expect(withMetadata.width).toBe(baseline.width);
    } finally {
      await mounted.unmount();
    }
  });
});
