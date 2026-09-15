export interface MarkdownPreviewPreparation {
  readonly text: string;
  /** 1-based lookup: renderedLineToSourceLine[renderedLine]. */
  readonly renderedLineToSourceLine: ReadonlyArray<number>;
}

/** Capture the opening whitespace too: the legacy matcher can consume blank lines. */
const YAML_FRONTMATTER_REGEX = /^(---\s*\n)([\s\S]*?)\n---\s*(?:\n|$)/;

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
  return content.replace(YAML_FRONTMATTER_REGEX, (_match, _opening, frontmatter: string) =>
    frontmatterReplacement(frontmatter),
  );
}

function identityLineMap(content: string): ReadonlyArray<number> {
  return [0, ...content.split("\n").map((_line, index) => index + 1)];
}

function frontmatterReplacement(frontmatter: string): string {
  return `---\n\n${processFrontmatter(frontmatter)}\n\n---\n`;
}

export function prepareYamlFrontmatterForPreview(content: string): MarkdownPreviewPreparation {
  const match = YAML_FRONTMATTER_REGEX.exec(content);
  if (!match) {
    return { text: content, renderedLineToSourceLine: identityLineMap(content) };
  }

  const opening = match[1] ?? "";
  const frontmatter = match[2] ?? "";
  const body = content.slice(match[0].length);
  const frontmatterStartLine = opening.split("\n").length;
  const frontmatterLines = frontmatter.split("\n");
  const closingSourceLine = frontmatterStartLine + frontmatterLines.length;
  const bodyStartLine = match[0].split("\n").length;

  return {
    text: `${frontmatterReplacement(frontmatter)}${body}`,
    renderedLineToSourceLine: [
      0,
      1,
      1,
      ...frontmatterLines.map((_line, index) => frontmatterStartLine + index),
      closingSourceLine,
      closingSourceLine,
      ...body.split("\n").map((_line, index) => bodyStartLine + index),
    ],
  };
}
