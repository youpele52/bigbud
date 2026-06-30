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

export function guardComputerUseAction(action: ComputerUseAction): string | null {
  if (action.action === "key") {
    for (const entry of BLOCKED_KEY_PATTERNS) {
      if (entry.pattern.test(action.key)) {
        return entry.reason;
      }
    }
  }

  if (action.action === "type") {
    for (const entry of SENSITIVE_TYPE_PATTERNS) {
      if (entry.pattern.test(action.text)) {
        return entry.reason;
      }
    }
  }

  return null;
}
