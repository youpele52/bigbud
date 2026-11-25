const TEXT_ENTITIES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const ATTRIBUTE_ENTITIES: Readonly<Record<string, string>> = {
  '"': "&quot;",
  "'": "&apos;",
  "\n": "&#10;",
  "\r": "&#13;",
  "\t": "&#9;",
};

export function escapeDocumentMarkup(text: string): string {
  return text.replace(/[&<>]/g, (character) => TEXT_ENTITIES[character]!);
}

export function documentMarkupPrefix(
  text: string,
  budget: number,
): { text: string; length: number } {
  if (text.length <= budget && !/[&<>]/.test(text)) return { text, length: text.length };
  let length = 0;
  let end = 0;
  for (const character of text) {
    const width = Object.hasOwn(TEXT_ENTITIES, character)
      ? TEXT_ENTITIES[character]!.length
      : character.length;
    if (length + width > budget) break;
    length += width;
    end += character.length;
  }
  return { text: text.slice(0, end), length };
}

export function escapeDocumentMarkupAttribute(text: string): string {
  return escapeDocumentMarkup(text).replace(
    /["'\n\r\t]/g,
    (character) => ATTRIBUTE_ENTITIES[character]!,
  );
}

/** Keep the embedded JSON valid while preventing string values from becoming markup. */
export function documentJsonForMarkup(value: readonly object[]): string {
  return JSON.stringify(value).replace(
    /[&<>]/g,
    (character) => `\\u00${character.charCodeAt(0).toString(16)}`,
  );
}
