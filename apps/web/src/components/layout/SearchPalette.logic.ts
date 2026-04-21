/**
 * Pure utility functions for search functionality.
 * Extracted for testability.
 */

export function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

export function getSnippet(text: string, matchIndex: number, snippetLength = 70): string {
  const start = Math.max(0, matchIndex - Math.floor(snippetLength / 2));
  const end = Math.min(text.length, start + snippetLength);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = "..." + snippet;
  if (end < text.length) snippet = snippet + "...";
  return snippet;
}

export interface HighlightResult {
  before: string;
  match: string;
  after: string;
  hasMatch: boolean;
}

export function highlightMatch(text: string, query: string): HighlightResult {
  if (!query) {
    return { before: text, match: "", after: "", hasMatch: false };
  }
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerText.indexOf(lowerQuery);
  if (index === -1) {
    return { before: text, match: "", after: "", hasMatch: false };
  }

  return {
    before: text.slice(0, index),
    match: text.slice(index, index + query.length),
    after: text.slice(index + query.length),
    hasMatch: true,
  };
}
