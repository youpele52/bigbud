import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("~/components/common/BaseMarkdown", () => ({
  BaseMarkdown: ({
    text,
    className,
    preserveLineBreaks,
  }: {
    text: string;
    className?: string;
    preserveLineBreaks?: boolean;
  }) => (
    <div
      data-class-name={className}
      data-preserve-line-breaks={preserveLineBreaks ? "true" : "false"}
    >
      {text}
    </div>
  ),
}));

import { FilePreviewMarkdownContent } from "./FilePreview.markdown";

describe("FilePreviewMarkdownContent", () => {
  it("uses the preview-specific markdown class and preserved line breaks", () => {
    const markup = renderToStaticMarkup(
      <FilePreviewMarkdownContent contents={"# Changelog\nLine two"} cwd="/workspace" />,
    );

    expect(markup).toContain('data-class-name="file-preview-markdown"');
    expect(markup).toContain('data-preserve-line-breaks="true"');
    expect(markup).toContain("# Changelog");
  });
});
