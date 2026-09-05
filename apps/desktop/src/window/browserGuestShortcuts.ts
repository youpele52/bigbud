export interface BrowserGuestShortcutInput {
  readonly type: string;
  readonly key: string;
  readonly meta?: boolean;
  readonly control?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

export function isBrowserGuestFocusLocationShortcut(
  input: BrowserGuestShortcutInput,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (input.type !== "keyDown" || input.key.toLowerCase() !== "l" || input.shift || input.alt) {
    return false;
  }

  return platform === "darwin"
    ? input.meta === true && input.control !== true
    : input.control === true && input.meta !== true;
}
