import { ruleNumbers, type Finding, type Rule } from "./rules.ts";

export interface AllowEntry {
  readonly path: string;
  readonly rule: Rule;
  readonly symbol?: string | null;
  readonly reason: string;
  readonly reference: string;
}

export interface Allowlist {
  readonly version: 1;
  readonly entries: readonly AllowEntry[];
}

function shape(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Missing ${label}`);
  return value;
}

export function parseAllowlist(value: unknown): Allowlist {
  const root = shape(value, "allowlist");
  if (root.version !== 1) throw new Error("Unsupported allowlist version");
  if (!Array.isArray(root.entries)) throw new Error("Missing allowlist entries");
  const entries = root.entries.map((item, index): AllowEntry => {
    const entry = shape(item, `allowlist entry ${index}`);
    const rule = entry.rule;
    if (typeof rule !== "number" || !ruleNumbers.includes(rule as Rule)) {
      throw new Error(`allowlist entry ${index}: invalid rule`);
    }
    const path = required(entry.path, `allowlist entry ${index} path`).replaceAll("\\", "/");
    const reason = required(entry.reason, `allowlist entry ${index} reason`);
    const reference = required(entry.reference, `allowlist entry ${index} reference`);
    const symbol = entry.symbol === undefined ? undefined : required(entry.symbol, "symbol");
    // U9: coordinator key creation moves into the owner; no ssh-keygen exception.
    if (/ssh-keygen/i.test(path) || /ssh-keygen/i.test(symbol ?? "")) {
      throw new Error(`allowlist entry ${index}: ssh-keygen is not allowlistable under U9`);
    }
    return {
      path,
      rule: rule as Rule,
      symbol: symbol ?? null,
      reason,
      reference,
    };
  });
  return { version: 1, entries };
}

function matches(entry: AllowEntry, finding: Finding): boolean {
  if (entry.rule !== finding.rule) return false;
  const pathMatches = entry.path.endsWith("/")
    ? finding.path === entry.path.slice(0, -1) || finding.path.startsWith(entry.path)
    : finding.path === entry.path;
  return pathMatches && (entry.symbol == null || entry.symbol === finding.symbol);
}

export function allowFinding(allowlist: Allowlist, finding: Finding): AllowEntry | undefined {
  return allowlist.entries.find((entry) => matches(entry, finding));
}
