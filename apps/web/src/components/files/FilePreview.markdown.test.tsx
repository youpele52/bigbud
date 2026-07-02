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

  it("formats YAML frontmatter so delimiters render as horizontal rules", () => {
    const contents = [
      "---",
      "name: ai-seo",
      'description: "When the user wants to optimize content for AI search engines."',
      "metadata:",
      "  version: 2.0.0",
      "---",
      "# AI SEO",
      "Body text",
    ].join("\n");

    const markup = renderToStaticMarkup(
      <FilePreviewMarkdownContent contents={contents} cwd="/workspace" />,
    );

    expect(markup).toContain("**name:** ai-seo");
    expect(markup).toContain("**description:**");
    expect(markup).toContain("When the user wants to optimize content for AI search engines.");
    expect(markup).toContain("**version:** 2.0.0");
    expect(markup).toContain("# AI SEO");
    expect(markup).toContain("Body text");
  });
});
