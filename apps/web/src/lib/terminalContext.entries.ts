import type { ParsedTerminalContextEntry } from "./terminalContext";

export function parseTerminalContextEntries(block: string): ParsedTerminalContextEntry[] {
  const entries: ParsedTerminalContextEntry[] = [];
  let current: { header: string; bodyLines: string[] } | null = null;

  const commitCurrent = () => {
    if (!current) {
      return;
    }
    entries.push({
      header: current.header,
      body: current.bodyLines.join("\n").trimEnd(),
    });
    current = null;
  };

  for (const rawLine of block.split("\n")) {
    const headerMatch = /^- (.+):$/.exec(rawLine);
    if (headerMatch) {
      commitCurrent();
      current = {
        header: headerMatch[1]!,
        bodyLines: [],
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (rawLine.startsWith("  ")) {
      current.bodyLines.push(rawLine.slice(2));
      continue;
    }
    if (rawLine.length === 0) {
      current.bodyLines.push("");
    }
  }

  commitCurrent();
  return entries;
}
