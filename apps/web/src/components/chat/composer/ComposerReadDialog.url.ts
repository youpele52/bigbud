export function parseComposerDocumentUrl(value: string): string | null {
  const input = value.trim();
  if (!/^https?:\/\/[^\s\\]+$/i.test(input) || input.length > 2048) return null;
  try {
    const url = new URL(input);
    if (url.username || url.password || url.href.length > 2048) return null;
    return url.href;
  } catch {
    return null;
  }
}
