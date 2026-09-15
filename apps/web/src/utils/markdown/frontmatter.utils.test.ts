import { describe, expect, it } from "vitest";

import {
  formatYamlFrontmatterForPreview,
  prepareYamlFrontmatterForPreview,
} from "./frontmatter.utils";

describe("formatYamlFrontmatterForPreview", () => {
  it("adds blank lines around frontmatter delimiters and boldens YAML keys", () => {
    const content = [
      "---",
      "name: ai-seo",
      'description: "A description"',
      "metadata:",
      "  version: 2.0.0",
      "---",
      "# AI SEO",
      "Body text",
    ].join("\n");

    expect(formatYamlFrontmatterForPreview(content)).toBe(
      [
        "---",
        "",
        "**name:** ai-seo",
        '**description:** "A description"',
        "**metadata:**",
        "\u00A0\u00A0**version:** 2.0.0",
        "",
        "---",
        "# AI SEO",
        "Body text",
      ].join("\n"),
    );
  });

  it("returns the full content when there is no frontmatter", () => {
    const content = "# Heading\nBody text";
    expect(formatYamlFrontmatterForPreview(content)).toBe("# Heading\nBody text");
  });

  it("preserves multi-level indentation with non-breaking spaces", () => {
    const content = [
      "---",
      "level1:",
      "  level2: value2",
      "    level3: value3",
      "---",
      "Body",
    ].join("\n");

    const result = formatYamlFrontmatterForPreview(content);
    expect(result).toContain("\u00A0\u00A0**level2:** value2");
    expect(result).toContain("\u00A0\u00A0\u00A0\u00A0**level3:** value3");
  });

  it("does not modify content that looks like frontmatter but is not at the start", () => {
    const content = "# Heading\n---\nkey: value\n---\nBody text";
    expect(formatYamlFrontmatterForPreview(content)).toBe(content);
  });

  it("maps inserted frontmatter lines back to their original source lines", () => {
    const content = [
      "---",
      "name: ai-seo",
      "description: A description",
      "---",
      "# AI SEO",
      "Body text",
    ].join("\n");

    const result = prepareYamlFrontmatterForPreview(content);

    expect(result.text).toBe(formatYamlFrontmatterForPreview(content));
    expect(result.renderedLineToSourceLine).toEqual([0, 1, 1, 2, 3, 4, 4, 5, 6]);
  });

  it("uses an identity map when frontmatter is absent", () => {
    const result = prepareYamlFrontmatterForPreview("# Heading\n\nBody");
    expect(result.renderedLineToSourceLine).toEqual([0, 1, 2, 3]);
  });

  it("maps retained frontmatter and body lines after the matcher consumes opening blank lines", () => {
    const content = ["---", "", "name: ai-seo", "", "---", "# AI SEO", ""].join("\n");
    const result = prepareYamlFrontmatterForPreview(content);

    expect(result.renderedLineToSourceLine).toEqual([0, 1, 1, 3, 4, 5, 5, 6, 7]);
    expect(result.renderedLineToSourceLine).toHaveLength(result.text.split("\n").length + 1);
  });

  it("maps CRLF frontmatter while preserving the legacy transformed line endings", () => {
    const content = "---\r\nname: ai-seo\r\n---\r\n# AI SEO\r\nBody";
    const result = prepareYamlFrontmatterForPreview(content);

    expect(result.text).toContain("**name:** ai-seo\r\n");
    expect(result.renderedLineToSourceLine).toEqual([0, 1, 1, 2, 3, 3, 4, 5]);
    expect(result.renderedLineToSourceLine).toHaveLength(result.text.split("\n").length + 1);
  });

  it("maps a closing delimiter at EOF without adding a phantom body mapping", () => {
    const result = prepareYamlFrontmatterForPreview("---\nname: ai-seo\n---");

    expect(result.renderedLineToSourceLine).toHaveLength(result.text.split("\n").length + 1);
    expect(result.renderedLineToSourceLine.at(-1)).toBe(3);
  });

  it.each([
    {
      name: "blank lines before and inside frontmatter",
      content: "---\n\nname: ai-seo\n\n---\n# AI SEO\n",
      expected: "---\n\n**name:** ai-seo\n\n\n---\n# AI SEO\n",
      lineMap: [0, 1, 1, 3, 4, 5, 5, 6, 7],
    },
    {
      name: "CRLF frontmatter and body",
      content: "---\r\nname: ai-seo\r\n---\r\n# AI SEO\r\nBody",
      expected: "---\n\n**name:** ai-seo\r\n\n---\n# AI SEO\r\nBody",
      lineMap: [0, 1, 1, 2, 3, 3, 4, 5],
    },
    {
      name: "adjacent delimiters excluded by the legacy matcher",
      content: "---\n---",
      expected: "---\n---",
      lineMap: [0, 1, 2],
    },
    {
      name: "empty captured frontmatter",
      content: "---\n\n---",
      expected: "---\n\n\n\n---\n",
      lineMap: [0, 1, 1, 2, 3, 3, 3],
    },
    {
      name: "whitespace consumed around delimiters and before the body",
      content: "--- \t\n\nname: ai-seo\n--- \t\n\n\n  # AI SEO\nBody",
      expected: "---\n\n**name:** ai-seo\n\n---\n  # AI SEO\nBody",
      lineMap: [0, 1, 1, 3, 4, 4, 7, 8],
    },
    {
      name: "whitespace-only frontmatter and trailing blank lines",
      content: "---\n \n---\n\n",
      expected: "---\n\n \n\n---\n",
      lineMap: [0, 1, 1, 2, 3, 3, 5],
    },
    {
      name: "closing delimiter at EOF",
      content: "---\nname: ai-seo\n---",
      expected: "---\n\n**name:** ai-seo\n\n---\n",
      lineMap: [0, 1, 1, 2, 3, 3, 3],
    },
    {
      name: "closing delimiter followed by an empty source line",
      content: "---\nname: ai-seo\n---\n",
      expected: "---\n\n**name:** ai-seo\n\n---\n",
      lineMap: [0, 1, 1, 2, 3, 3, 4],
    },
    {
      name: "unclosed frontmatter",
      content: "---\nname: ai-seo\nBody",
      expected: "---\nname: ai-seo\nBody",
      lineMap: [0, 1, 2, 3],
    },
  ])("preserves the legacy output for $name", ({ content, expected, lineMap }) => {
    const result = prepareYamlFrontmatterForPreview(content);

    expect(formatYamlFrontmatterForPreview(content)).toBe(expected);
    expect(result.text).toBe(expected);
    expect(result.renderedLineToSourceLine).toEqual(lineMap);
    expect(result.renderedLineToSourceLine).toHaveLength(result.text.split("\n").length + 1);
  });
});
