export const EXTRACTED_DOCUMENT_MAX_CHARS = 32_000;

export function normalizeExtractedText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncateExtractedText(value: string): string {
  if (value.length <= EXTRACTED_DOCUMENT_MAX_CHARS) return value;
  return `${value.slice(0, EXTRACTED_DOCUMENT_MAX_CHARS).trimEnd()}\n\n[Document text truncated]`;
}
