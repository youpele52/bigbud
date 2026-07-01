import type { ComputerUseAction } from "@bigbud/contracts";

const BLOCKED_KEY_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly reason: string;
}> = [
  { pattern: /^(meta|cmd|command)\+q$/i, reason: "Force quit is blocked." },
  { pattern: /^(alt|option)\+f4$/i, reason: "Window close via Alt+F4 is blocked." },
  { pattern: /^(ctrl|control)\+alt\+(del|delete)$/i, reason: "Ctrl+Alt+Del is blocked." },
  { pattern: /^(ctrl|control)\+shift\+esc$/i, reason: "Task manager shortcut is blocked." },
  { pattern: /^(meta|cmd|command)\+shift\+q$/i, reason: "Force quit all apps is blocked." },
  {
    pattern: /^(meta|cmd|command)\+shift\+option\+esc$/i,
    reason: "Force quit frontmost app is blocked.",
  },
  { pattern: /^(meta|cmd|command)\+control\+q$/i, reason: "Lock screen shortcut is blocked." },
  { pattern: /^(meta|cmd|command)\+shift\+power$/i, reason: "Sleep shortcut is blocked." },
  { pattern: /^(ctrl|control)\+shift\+power$/i, reason: "Sleep shortcut is blocked." },
];

const SENSITIVE_TYPE_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly reason: string;
}> = [
  {
    pattern: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)\b/i,
    reason: "Typing sensitive credentials is blocked for safety.",
  },
  {
    pattern: /\b(?:\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})\b/,
    reason: "Typing credit-card-like numbers is blocked for safety.",
  },
  {
    pattern: /\b(?:\d{3}[\s-]?\d{2}[\s-]?\d{4})\b/,
    reason: "Typing SSN-like numbers is blocked for safety.",
  },
];

const SENSITIVE_APP_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly reason: string;
}> = [
  {
    pattern: /\b(?:terminal|iterm|kitty|alacritty|wezterm|powershell|cmd)\b/i,
    reason: "Desktop automation of terminal apps requires explicit user confirmation.",
  },
  {
    pattern: /\b(?:1password|bitwarden|keychain|password|keeper|lastpass|dashlane)\b/i,
    reason: "Desktop automation of password managers is blocked for safety.",
  },
  {
    pattern: /\b(?:system settings|system preferences|activity monitor|disk utility)\b/i,
    reason: "Desktop automation of system utilities is blocked for safety.",
  },
];

const SENSITIVE_URL_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly reason: string;
}> = [
  {
    pattern: /\b(?:bank|banking|paypal|stripe|checkout|billing|payment|wallet)\b/i,
    reason: "Browser automation on payment or banking pages requires explicit user confirmation.",
  },
];

function isMutatingAction(action: ComputerUseAction): boolean {
  switch (action.action) {
    case "capture":
    case "list_windows":
    case "list_apps":
    case "check_permissions":
    case "doctor":
    case "get_accessibility_tree":
    case "get_page_info":
      return false;
    default:
      return true;
  }
}

function guardTextPatterns(
  value: string | null | undefined,
  entries: ReadonlyArray<{ readonly pattern: RegExp; readonly reason: string }>,
): string | null {
  if (!value) {
    return null;
  }
  for (const entry of entries) {
    if (entry.pattern.test(value)) {
      return entry.reason;
    }
  }
  return null;
}

export function guardComputerUseAction(action: ComputerUseAction): string | null {
  if (action.action === "key") {
    for (const entry of BLOCKED_KEY_PATTERNS) {
      if (entry.pattern.test(action.key)) {
        return entry.reason;
      }
    }
  }

  if (action.action === "type") {
    return guardTextPatterns(action.text, SENSITIVE_TYPE_PATTERNS);
  }

  if (action.action === "launch_app" || action.action === "focus_app") {
    return guardTextPatterns(action.name, SENSITIVE_APP_PATTERNS);
  }

  if (action.action === "navigate") {
    return guardTextPatterns(action.url, SENSITIVE_URL_PATTERNS);
  }

  return null;
}

export function guardComputerUseTarget(input: {
  readonly action: ComputerUseAction;
  readonly surface: "browser" | "desktop";
  readonly url?: string | null;
  readonly appName?: string | null;
  readonly title?: string | null;
}): string | null {
  if (!isMutatingAction(input.action)) {
    return null;
  }
  if (input.surface === "browser") {
    return guardTextPatterns(input.url, SENSITIVE_URL_PATTERNS);
  }
  return (
    guardTextPatterns(input.appName, SENSITIVE_APP_PATTERNS) ??
    guardTextPatterns(input.title, SENSITIVE_APP_PATTERNS)
  );
}

export function isComputerUseMutatingAction(action: ComputerUseAction): boolean {
  return isMutatingAction(action);
}
