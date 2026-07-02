import { describe, expect, it } from "vitest";

import { formatYamlFrontmatterForPreview } from "./frontmatter.utils";

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
});
