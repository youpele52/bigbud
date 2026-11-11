import type { ParsedDelegatedThreadProvenance, ParsedReadDocumentEntry } from "./terminalContext";

const TRAILING_READ_DOCUMENT_BLOCK_PATTERN =
  /\n*<read_document_result>\n([\s\S]*?)\n<\/read_document_result>\s*$/;
const READ_DOCUMENT_SOURCE_URL_PATTERN = /^Source URL:\s*(.+)$/m;
const READ_DOCUMENT_RESOLVED_URL_PATTERN = /^Resolved URL:\s*(.+)$/m;
const READ_DOCUMENT_TITLE_PATTERN = /^Title:\s*(.+)$/m;
const READ_DOCUMENT_TEXT_PATTERN = /<document_contents>\n([\s\S]*?)\n<\/document_contents>/;
const DELEGATED_THREAD_PROVENANCE_OPEN_TAG = "<delegated_thread_provenance>\n";
const DELEGATED_THREAD_PROVENANCE_CLOSE_TAG = "\n</delegated_thread_provenance>";

export function extractLeadingDelegatedThreadProvenance(prompt: string): {
  promptText: string;
  provenance: ParsedDelegatedThreadProvenance | null;
} {
  if (!prompt.startsWith(DELEGATED_THREAD_PROVENANCE_OPEN_TAG)) {
    return { promptText: prompt, provenance: null };
  }

  const closeTagIndex = prompt.indexOf(
    DELEGATED_THREAD_PROVENANCE_CLOSE_TAG,
    DELEGATED_THREAD_PROVENANCE_OPEN_TAG.length,
  );
  if (closeTagIndex === -1) {
    return { promptText: prompt, provenance: null };
  }

  const body = prompt.slice(DELEGATED_THREAD_PROVENANCE_OPEN_TAG.length, closeTagIndex);
  const blockEnd = closeTagIndex + DELEGATED_THREAD_PROVENANCE_CLOSE_TAG.length;
  const separatorLength = prompt.startsWith("\n\n", blockEnd) ? 2 : 0;
  return {
    promptText: prompt.slice(blockEnd + separatorLength),
    provenance: { body },
  };
}

export function extractTrailingReadDocument(prompt: string): {
  promptText: string;
  document: ParsedReadDocumentEntry | null;
} {
  const match = TRAILING_READ_DOCUMENT_BLOCK_PATTERN.exec(prompt);
  if (!match) {
    return { promptText: prompt, document: null };
  }

  const block = match[1] ?? "";
  const promptText = prompt.slice(0, match.index).replace(/\n+$/, "");
  const sourceUrl = READ_DOCUMENT_SOURCE_URL_PATTERN.exec(block)?.[1]?.trim() ?? "";
  const resolvedUrl = READ_DOCUMENT_RESOLVED_URL_PATTERN.exec(block)?.[1]?.trim() ?? "";
  const title = READ_DOCUMENT_TITLE_PATTERN.exec(block)?.[1]?.trim() ?? "";
  const text = READ_DOCUMENT_TEXT_PATTERN.exec(block)?.[1]?.trim() ?? "";

  if (!sourceUrl || !resolvedUrl || !text) {
    return { promptText: prompt, document: null };
  }

  return {
    promptText,
    document: {
      sourceUrl,
      resolvedUrl,
      title: title.length > 0 ? title : null,
      text,
    },
  };
}
