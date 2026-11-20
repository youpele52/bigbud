export function truncate(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength)}...`;
}

export function countUnicodeCodePoints(text: string): number {
  let count = 0;
  for (const _character of text) count += 1;
  return count;
}

export const DEFAULT_THREAD_TITLE = "New thread";

export function fallbackThreadTitleFromPrompt(prompt: string, maxLength = 25): string {
  const normalized = prompt.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) {
    return DEFAULT_THREAD_TITLE;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength).trimEnd()}...`;
}

// Bidirectional embedding, override and isolate controls plus directional marks.
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;

/**
 * Makes bidirectional control characters visible (`⟨U+202E⟩`) so untrusted names such as file
 * paths cannot visually reorder themselves (for example to fake an extension).
 */
export function revealBidiControls(text: string): string {
  return text.replace(
    BIDI_CONTROLS,
    (control) => `⟨U+${(control.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟩`,
  );
}
