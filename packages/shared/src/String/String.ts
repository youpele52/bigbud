export function truncate(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength)}...`;
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
