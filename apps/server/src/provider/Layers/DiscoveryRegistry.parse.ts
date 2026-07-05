import * as OS from "node:os";

import type {
  ServerDiscoveredAgent,
  ServerDiscoveredSkill,
  ServerDiscoveryProviderLabel,
} from "@bigbud/contracts";

import type { DiscoveryFileDescriptor } from "./DiscoveryRegistry.descriptors.ts";

export interface ParsedDiscoveryFileEntry {
  readonly kind: DiscoveryFileDescriptor["kind"];
  readonly entry: ServerDiscoveredAgent | ServerDiscoveredSkill;
}

const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;
const FRONTMATTER_NAME_REGEX = /^name:\s*(.+)$/im;
const FRONTMATTER_DISPLAY_NAME_REGEX = /^(?:displayName|title):\s*(.+)$/im;
const FRONTMATTER_DESCRIPTION_REGEX = /^(?:description|summary):\s*(.+)$/im;
const HEADER_NAME_REGEX = /^#\s+(.+)$/m;
const OPENCODE_AGENT_SECTION_REGEX = /^agent\s*=\s*\{([\s\S]*?)\}/gm;
const OPENCODE_AGENT_NAME_REGEX = /name\s*=\s*"([^"]+)"/;
const OPENCODE_AGENT_DESCRIPTION_REGEX = /description\s*=\s*"([^"]+)"/;
const OPENCODE_JSON_AGENT_KEY_REGEX = /"agent"\s*:\s*\{/g;
const OPENCODE_JSON_AGENT_ENTRY_START_REGEX = /"([^"]+)"\s*:\s*\{/g;
const OPENCODE_JSON_AGENT_DESC_REGEX = /"description"\s*:\s*"([^"]*)"/;
const CODEX_TOML_NAME_REGEX = /^name\s*=\s*(["'])(.*?)\1/m;
const CODEX_TOML_DESCRIPTION_REGEX = /^description\s*=\s*(["'])(.*?)\1/m;
const CLAUDE_JSON_NAME_REGEX = /"name"\s*:\s*"([^"]+)"/;
const CLAUDE_JSON_DESCRIPTION_REGEX = /"description"\s*:\s*"([^"]+)"/;
const SIMPLE_NAME_REGEX = /^(?:name|title):\s*(.+)$/im;
const SIMPLE_DESCRIPTION_REGEX = /^description:\s*(.+)$/im;

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sanitizeDiscoveredValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function inferNameFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const lastSegment = normalized.split("/").at(-1) ?? normalized;
  if (/^(?:SKILL|skill)\.md$/u.test(lastSegment)) {
    return normalized.split("/").at(-2) ?? "skill";
  }
  return lastSegment.replace(/\.(md|markdown|ya?ml|toml|json)$/i, "");
}

function buildDiscoveryId(
  provider: ServerDiscoveryProviderLabel,
  kind: "agent" | "skill",
  name: string,
): string {
  return `${provider}:${kind}:${sanitizeDiscoveredValue(name).toLowerCase()}`;
}

function parseFrontmatter(content: string): {
  name?: string;
  displayName?: string;
  description?: string;
} {
  const frontmatter = FRONTMATTER_REGEX.exec(content)?.[1];
  if (!frontmatter) {
    return {};
  }
  const name = trimToUndefined(FRONTMATTER_NAME_REGEX.exec(frontmatter)?.[1]);
  const displayName = trimToUndefined(FRONTMATTER_DISPLAY_NAME_REGEX.exec(frontmatter)?.[1]);
  const description = trimToUndefined(FRONTMATTER_DESCRIPTION_REGEX.exec(frontmatter)?.[1]);
  return {
    ...(name ? { name } : {}),
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
  };
}

function parseMarkdownDiscovery(
  content: string,
  fallbackName: string,
): {
  name: string;
  displayName?: string;
  description?: string;
} {
  const frontmatter = parseFrontmatter(content);
  const headingName = trimToUndefined(HEADER_NAME_REGEX.exec(content)?.[1]);
  const simpleName = trimToUndefined(SIMPLE_NAME_REGEX.exec(content)?.[1]);
  const simpleDescription = trimToUndefined(SIMPLE_DESCRIPTION_REGEX.exec(content)?.[1]);
  const name = frontmatter.name ?? simpleName ?? fallbackName;
  const displayName = frontmatter.displayName ?? headingName;
  const description = frontmatter.description ?? simpleDescription;
  return {
    name,
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
  };
}

function parseClaudeJsonAgent(
  content: string,
  fallbackName: string,
): {
  name: string;
  description?: string;
} {
  const parsedName = trimToUndefined(CLAUDE_JSON_NAME_REGEX.exec(content)?.[1]);
  const parsedDescription = trimToUndefined(CLAUDE_JSON_DESCRIPTION_REGEX.exec(content)?.[1]);
  const name = parsedName ?? fallbackName;
  return {
    name,
    ...(parsedDescription ? { description: parsedDescription } : {}),
  };
}

function parseCodexTomlAgent(
  content: string,
  fallbackName: string,
): {
  name: string;
  description?: string;
} {
  const parsedName = trimToUndefined(CODEX_TOML_NAME_REGEX.exec(content)?.[2]);
  const parsedDescription = trimToUndefined(CODEX_TOML_DESCRIPTION_REGEX.exec(content)?.[2]);
  const name = parsedName ?? fallbackName;
  return {
    name,
    ...(parsedDescription ? { description: parsedDescription } : {}),
  };
}

export function parseDiscoveryFile(
  input: DiscoveryFileDescriptor & { readonly content: string },
): ParsedDiscoveryFileEntry {
  const fallbackName = inferNameFromPath(input.path);
  const parsed =
    input.provider === "codex" && input.kind === "agent"
      ? parseCodexTomlAgent(input.content, fallbackName)
      : input.provider === "claudeAgent" && input.kind === "agent" && input.path.endsWith(".json")
        ? parseClaudeJsonAgent(input.content, fallbackName)
        : parseMarkdownDiscovery(input.content, fallbackName);
  const name = sanitizeDiscoveredValue(parsed.name);
  const base = {
    id: buildDiscoveryId(input.provider, input.kind, name),
    provider: input.provider,
    name,
    source: input.source,
    ...(input.kind === "skill" && "displayName" in parsed && parsed.displayName
      ? { displayName: sanitizeDiscoveredValue(String(parsed.displayName)) }
      : {}),
    ...(parsed.description ? { description: sanitizeDiscoveredValue(parsed.description) } : {}),
    sourcePath: sanitizeDiscoveredValue(input.path),
  };
  return input.kind === "agent"
    ? {
        kind: input.kind,
        entry: base satisfies ServerDiscoveredAgent,
      }
    : {
        kind: input.kind,
        entry: base satisfies ServerDiscoveredSkill,
      };
}

function parseOpencodeJsonConfigAgents(
  configPath: string,
  content: string,
): ReadonlyArray<ServerDiscoveredAgent> {
  OPENCODE_JSON_AGENT_KEY_REGEX.lastIndex = 0;
  const keyMatch = OPENCODE_JSON_AGENT_KEY_REGEX.exec(content);
  if (!keyMatch) {
    return [];
  }

  const blockStart = keyMatch.index + keyMatch[0].length - 1;
  let depth = 1;
  let blockEnd = blockStart;
  for (let i = blockStart + 1; i < content.length && depth > 0; i++) {
    if (content[i] === "{") {
      depth += 1;
    } else if (content[i] === "}") {
      depth -= 1;
    }
    if (depth === 0) {
      blockEnd = i;
    }
  }

  const agentBlock = content.slice(blockStart + 1, blockEnd);
  const source: ServerDiscoveredAgent["source"] = configPath.includes(`${OS.homedir()}/`)
    ? "user"
    : "project";

  const entries: Array<ServerDiscoveredAgent> = [];
  OPENCODE_JSON_AGENT_ENTRY_START_REGEX.lastIndex = 0;
  let startMatch: RegExpExecArray | null;
  while ((startMatch = OPENCODE_JSON_AGENT_ENTRY_START_REGEX.exec(agentBlock)) !== null) {
    const name = trimToUndefined(startMatch[1]);
    if (!name) {
      continue;
    }

    const entryBracePos = startMatch.index + startMatch[0].length - 1;
    let entryDepth = 1;
    let entryEnd = entryBracePos;
    for (let i = entryBracePos + 1; i < agentBlock.length && entryDepth > 0; i++) {
      if (agentBlock[i] === "{") {
        entryDepth += 1;
      } else if (agentBlock[i] === "}") {
        entryDepth -= 1;
      }
      if (entryDepth === 0) {
        entryEnd = i;
      }
    }

    OPENCODE_JSON_AGENT_ENTRY_START_REGEX.lastIndex = entryEnd + 1;

    const entryBody = agentBlock.slice(entryBracePos + 1, entryEnd);
    const description = trimToUndefined(OPENCODE_JSON_AGENT_DESC_REGEX.exec(entryBody)?.[1]);
    entries.push({
      id: buildDiscoveryId("opencode", "agent", name),
      provider: "opencode",
      name: sanitizeDiscoveredValue(name),
      source,
      ...(description ? { description: sanitizeDiscoveredValue(description) } : {}),
      sourcePath: sanitizeDiscoveredValue(configPath),
    } satisfies ServerDiscoveredAgent);
  }
  return entries;
}

export function parseOpencodeConfigAgents(
  configPath: string,
  content: string,
): ReadonlyArray<ServerDiscoveredAgent> {
  const entries = Array.from(content.matchAll(OPENCODE_AGENT_SECTION_REGEX)).flatMap((match) => {
    const body = match[1] ?? "";
    const name = trimToUndefined(OPENCODE_AGENT_NAME_REGEX.exec(body)?.[1]);
    if (!name) {
      return [];
    }
    const description = trimToUndefined(OPENCODE_AGENT_DESCRIPTION_REGEX.exec(body)?.[1]);
    return [
      {
        id: buildDiscoveryId("opencode", "agent", name),
        provider: "opencode" as const,
        name: sanitizeDiscoveredValue(name),
        source: configPath.includes(`${OS.homedir()}/`) ? "user" : "project",
        ...(description ? { description: sanitizeDiscoveredValue(description) } : {}),
        sourcePath: sanitizeDiscoveredValue(configPath),
      } satisfies ServerDiscoveredAgent,
    ];
  });
  if (entries.length === 0) {
    return parseOpencodeJsonConfigAgents(configPath, content);
  }
  return entries;
}

function sortDiscoveredEntries<T extends ServerDiscoveredAgent | ServerDiscoveredSkill>(
  entries: ReadonlyArray<T>,
): Array<T> {
  return [...entries].toSorted((left, right) => {
    const byName = left.name.localeCompare(right.name);
    if (byName !== 0) return byName;
    const byProvider = left.provider.localeCompare(right.provider);
    if (byProvider !== 0) return byProvider;
    return left.id.localeCompare(right.id);
  });
}

export function mergeEntries<T extends ServerDiscoveredAgent | ServerDiscoveredSkill>(
  entries: ReadonlyArray<T>,
): Array<T> {
  const deduped = new Map<string, T>();
  for (const entry of entries) {
    const key = `${entry.provider}:${entry.name.trim().toLowerCase()}`;
    if (!deduped.has(key)) {
      deduped.set(key, entry);
    }
  }
  return sortDiscoveredEntries([...deduped.values()]);
}
