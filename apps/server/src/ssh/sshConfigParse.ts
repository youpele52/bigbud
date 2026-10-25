/**
 * Pure OpenSSH client-config reader used only to list host aliases for the
 * remote-project picker. It never resolves effective settings: OpenSSH stays
 * responsible for `Host`/`Match` evaluation when a connection is made.
 *
 * @module sshConfigParse
 */

export interface SshConfigHostEntry {
  readonly alias: string;
  readonly line: number;
  /** Literal values from the alias's own `Host` block, for display only. */
  hostName?: string;
  user?: string;
  port?: string;
}

export interface SshConfigIncludeEntry {
  readonly patterns: ReadonlyArray<string>;
  readonly line: number;
}

/** File-ordered items so callers can splice included files in place. */
export type SshConfigItem =
  | ({ readonly kind: "host" } & SshConfigHostEntry)
  | ({ readonly kind: "include" } & SshConfigIncludeEntry);

const HINT_KEYWORDS = {
  hostname: "hostName",
  user: "user",
  port: "port",
} as const satisfies Record<string, keyof SshConfigHostEntry>;

/** Splits one config line into keyword and arguments; `null` for blank or comment lines. */
export function tokenizeSshConfigLine(
  rawLine: string,
): { readonly keyword: string; readonly args: ReadonlyArray<string> } | null {
  const line = rawLine.trim();
  if (line.length === 0 || line.startsWith("#")) {
    return null;
  }

  const keywordMatch = /^([^\s=]+)\s*(?:=\s*|\s+|$)/u.exec(line);
  if (!keywordMatch?.[1]) {
    return null;
  }
  const keyword = keywordMatch[1].toLowerCase();
  const args: string[] = [];
  const rest = line.slice(keywordMatch[0].length);
  let index = 0;
  while (index < rest.length) {
    const char = rest[index]!;
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === "#") {
      break;
    }
    if (char === '"') {
      const end = rest.indexOf('"', index + 1);
      const stop = end === -1 ? rest.length : end;
      args.push(rest.slice(index + 1, stop));
      index = stop + 1;
      continue;
    }
    let end = index;
    while (end < rest.length && !/\s/u.test(rest[end]!)) {
      end += 1;
    }
    args.push(rest.slice(index, end));
    index = end;
  }
  return { keyword, args };
}

/** A concrete alias names one host; patterns and negations cannot be connected to directly. */
export function isConcreteSshHostAlias(pattern: string): boolean {
  return pattern.length > 0 && !/[*?!]/u.test(pattern);
}

export function parseSshConfig(content: string): ReadonlyArray<SshConfigItem> {
  const items: SshConfigItem[] = [];
  let block: Array<{ kind: "host" } & SshConfigHostEntry> | null = null;
  const lines = content.replace(/^﻿/u, "").split(/\r?\n/u);

  lines.forEach((rawLine, index) => {
    const token = tokenizeSshConfigLine(rawLine);
    if (!token) return;
    const lineNumber = index + 1;

    if (token.keyword === "host") {
      block = [];
      for (const pattern of token.args) {
        if (!isConcreteSshHostAlias(pattern)) continue;
        const entry = { kind: "host" as const, alias: pattern, line: lineNumber };
        block.push(entry);
        items.push(entry);
      }
      return;
    }
    if (token.keyword === "match") {
      block = null;
      return;
    }
    if (token.keyword === "include") {
      if (token.args.length > 0) {
        items.push({ kind: "include", patterns: token.args, line: lineNumber });
      }
      return;
    }

    const hintKey = HINT_KEYWORDS[token.keyword as keyof typeof HINT_KEYWORDS];
    const value = token.args[0];
    if (!hintKey || !value || !block) return;
    for (const entry of block as Array<SshConfigHostEntry>) {
      // OpenSSH uses the first value it obtains for each option.
      entry[hintKey] ??= value;
    }
  });

  return items;
}
