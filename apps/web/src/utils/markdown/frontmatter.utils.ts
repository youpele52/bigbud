/** Regex matching YAML frontmatter at the start of a markdown file. */
const YAML_FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;

/**
 * Bolden YAML keys and preserve leading indentation within frontmatter.
 *
 * Leading whitespace is converted to non-breaking spaces so that nested
 * YAML structure (e.g. a key indented under a parent) remains visible
 * in the rendered preview where HTML would otherwise collapse spaces.
 */
function processFrontmatter(frontmatter: string): string {
  return frontmatter
    .split("\n")
    .map((line) => {
      const indent = line.match(/^(\s*)/)?.[1] ?? "";
      const content = line.slice(indent.length);
      if (!content) return line;

      const preservedIndent = indent
        .replace(/ /g, "\u00A0")
        .replace(/\t/g, "\u00A0\u00A0\u00A0\u00A0");

      const bolded = content.replace(/^([\w][\w\s-]*?):/, "**$1:**");

      return `${preservedIndent}${bolded}`;
    })
    .join("\n");
}

/**
 * Prepare YAML frontmatter for markdown preview.
 *
 * Adds blank lines around the `---` delimiter lines so they render as
 * horizontal rules, boldens YAML keys for readability, and preserves
 * leading indentation to show nesting.
 */
export function formatYamlFrontmatterForPreview(content: string): string {
  return content.replace(
    YAML_FRONTMATTER_REGEX,
    (_match, frontmatter) => `---\n\n${processFrontmatter(frontmatter)}\n\n---\n`,
  );
}
