const FRONTMATTER_REGEX = /^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/u;
const HEADING_REGEX = /^#{1,6}\s+.+$/gmu;
const SENSITIVE_REGEX =
  /(?:api[_-]?key|access[_-]?token|secret|password|authorization)\s*[:=]\s*\S+/iu;
const MAX_PATCH_TEXT_CHARS = 16_000;

export function validateMemoryReplacement(current: string, proposed: string): boolean {
  if (SENSITIVE_REGEX.test(proposed) || proposed.includes("\0")) return false;
  if (current.length > 400 && proposed.length < current.length / 2) return false;
  return true;
}

export function applyValidatedSkillPatch(input: {
  readonly current: string;
  readonly oldText: string;
  readonly newText: string;
}): string | null {
  if (
    !input.oldText ||
    !input.newText ||
    input.oldText === input.current ||
    input.oldText.length > MAX_PATCH_TEXT_CHARS ||
    input.newText.length > MAX_PATCH_TEXT_CHARS ||
    input.newText.includes("\0") ||
    input.current.split(input.oldText).length !== 2
  ) {
    return null;
  }
  const proposed = input.current.replace(input.oldText, input.newText);
  if (
    (input.current.includes("\r\n") && !proposed.includes("\r\n")) ||
    proposed.length > input.current.length + MAX_PATCH_TEXT_CHARS
  ) {
    return null;
  }
  if (
    (FRONTMATTER_REGEX.exec(input.current)?.[0] ?? "") !==
    (FRONTMATTER_REGEX.exec(proposed)?.[0] ?? "")
  ) {
    return null;
  }
  const currentHeadings = input.current.match(HEADING_REGEX) ?? [];
  const proposedHeadings = proposed.match(HEADING_REGEX) ?? [];
  return currentHeadings.join("\n") === proposedHeadings.join("\n") ? proposed : null;
}
