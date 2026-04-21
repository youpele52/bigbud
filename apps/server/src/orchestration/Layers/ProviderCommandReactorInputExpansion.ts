import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type OrchestrationThread,
  type ProviderKind,
  type ServerDiscoveredAgent,
  type ServerDiscoveredSkill,
} from "@bigbud/contracts";
import { Effect, FileSystem } from "effect";

import type { DiscoveryRegistryShape } from "../../provider/Services/DiscoveryRegistry.ts";
import type { WorkspacePathsShape } from "../../workspace/Services/WorkspacePaths.ts";

const COMPACT_MENTION_REGEX = /(^|\s)@([^\s@]+)(?=\s|$)/g;
const MAX_REFERENCE_BLOCKS = 12;
const MAX_DIRECTORY_ENTRIES = 80;
const MAX_TEXT_BLOCK_CHARS = 16_000;

type DiscoveryEntry = ServerDiscoveredAgent | ServerDiscoveredSkill;
type CompactMention =
  | {
      readonly kind: "agent" | "skill";
      readonly rawValue: string;
      readonly name: string;
    }
  | {
      readonly kind: "path";
      readonly rawValue: string;
      readonly path: string;
    };

export type ProviderCommandReactorInputExpansionServices = {
  readonly discoveryRegistry: DiscoveryRegistryShape;
  readonly fileSystem: FileSystem.FileSystem;
  readonly workspacePaths: WorkspacePathsShape;
};

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const suffix = "\n\n[Truncated to fit provider input limit.]";
  return `${value.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd()}${suffix}`;
}

function trimToUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function collectCompactMentions(messageText: string): Array<CompactMention> {
  const mentions: Array<CompactMention> = [];
  const seen = new Set<string>();

  for (const match of messageText.matchAll(COMPACT_MENTION_REGEX)) {
    const rawValue = match[2]?.trim();
    if (!rawValue || seen.has(rawValue)) {
      continue;
    }
    seen.add(rawValue);
    if (rawValue.startsWith("agent:") || rawValue.startsWith("agent::")) {
      const name = trimToUndefined(rawValue.replace(/^agent::?/, ""));
      if (name) {
        mentions.push({ kind: "agent", rawValue, name });
      }
      continue;
    }
    if (rawValue.startsWith("skill:") || rawValue.startsWith("skill::")) {
      const name = trimToUndefined(rawValue.replace(/^skill::?/, ""));
      if (name) {
        mentions.push({ kind: "skill", rawValue, name });
      }
      continue;
    }
    mentions.push({ kind: "path", rawValue, path: rawValue });
  }

  return mentions;
}

function sourceRank(source: DiscoveryEntry["source"]): number {
  switch (source) {
    case "project":
      return 0;
    case "user":
      return 1;
    case "config":
      return 2;
    case "plugin":
      return 3;
    case "system":
      return 4;
  }
}

function resolveDiscoveryEntry<T extends DiscoveryEntry>(input: {
  readonly entries: ReadonlyArray<T>;
  readonly name: string;
  readonly preferredProvider: ProviderKind;
}):
  | { readonly status: "resolved"; readonly entry: T }
  | { readonly status: "missing" }
  | { readonly status: "ambiguous"; readonly entries: Array<T> } {
  const matching = input.entries.filter(
    (entry) => entry.name.trim().toLowerCase() === input.name.trim().toLowerCase(),
  );
  if (matching.length === 0) {
    return { status: "missing" };
  }

  const preferredEntry = matching.find((entry) => entry.provider === input.preferredProvider);
  if (preferredEntry) {
    return { status: "resolved", entry: preferredEntry };
  }

  if (matching.length === 1) {
    return { status: "resolved", entry: matching[0]! };
  }

  return {
    status: "ambiguous",
    entries: [...matching].toSorted((left, right) => {
      const bySource = sourceRank(left.source) - sourceRank(right.source);
      if (bySource !== 0) {
        return bySource;
      }
      return left.provider.localeCompare(right.provider);
    }),
  };
}

function buildDiscoveryHeader(input: {
  readonly kind: "agent" | "skill";
  readonly entry: DiscoveryEntry;
}): string {
  return [
    `Referenced ${input.kind}: ${input.entry.name}`,
    `Provider: ${input.entry.provider}`,
    `Source: ${input.entry.source}`,
    ...(input.entry.description ? [`Description: ${input.entry.description}`] : []),
    ...(input.entry.sourcePath ? [`Source path: ${input.entry.sourcePath}`] : []),
  ].join("\n");
}

function buildDiscoveryInstruction(kind: "agent" | "skill"): string {
  return kind === "agent"
    ? "The user invoked this agent. Apply these instructions for this turn while still obeying higher-priority system and tool rules."
    : "The user referenced this skill. Use it as active guidance where relevant while still obeying higher-priority system and tool rules.";
}

function extractOpencodeConfigAgentBlock(content: string, agentName: string): string | null {
  const agentBlockRegex = /agent\s*=\s*\{([\s\S]*?)\}/gm;
  const nameRegex = /name\s*=\s*"([^"]+)"/;

  for (const match of content.matchAll(agentBlockRegex)) {
    const block = match[0]?.trim();
    const blockBody = match[1] ?? "";
    const blockName = nameRegex.exec(blockBody)?.[1]?.trim().toLowerCase();
    if (block && blockName === agentName.trim().toLowerCase()) {
      return block;
    }
  }

  return null;
}

const loadDiscoverySourceText = Effect.fn("loadDiscoverySourceText")(function* (
  services: ProviderCommandReactorInputExpansionServices,
  entry: DiscoveryEntry,
) {
  if (!entry.sourcePath) {
    return null;
  }

  const rawContent = yield* services.fileSystem
    .readFileString(entry.sourcePath)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (!rawContent) {
    return null;
  }

  if (entry.provider === "opencode" && entry.sourcePath.endsWith("opencode.json")) {
    return extractOpencodeConfigAgentBlock(rawContent, entry.name) ?? rawContent;
  }

  return rawContent;
});

const buildDiscoveryReferenceBlock = Effect.fn("buildDiscoveryReferenceBlock")(function* (
  services: ProviderCommandReactorInputExpansionServices,
  input: {
    readonly kind: "agent" | "skill";
    readonly entry: DiscoveryEntry;
  },
) {
  const sourceText = yield* loadDiscoverySourceText(services, input.entry);
  const lines = [buildDiscoveryHeader(input), "", buildDiscoveryInstruction(input.kind)];

  if (sourceText) {
    lines.push("", "Instructions:", truncateText(sourceText, MAX_TEXT_BLOCK_CHARS));
  }

  return lines.join("\n");
});

const buildPathReferenceBlock = Effect.fn("buildPathReferenceBlock")(function* (
  services: ProviderCommandReactorInputExpansionServices,
  input: {
    readonly rawPath: string;
    readonly workspaceRoot: string;
  },
) {
  const resolvedPath = yield* services.workspacePaths
    .resolveRelativePathWithinRoot({
      workspaceRoot: input.workspaceRoot,
      relativePath: input.rawPath,
    })
    .pipe(Effect.catch(() => Effect.succeed(null)));

  if (!resolvedPath) {
    return [
      `Referenced path: ${input.rawPath}`,
      `The path could not be resolved within the workspace root '${input.workspaceRoot}'.`,
    ].join("\n");
  }

  const stat = yield* services.fileSystem
    .stat(resolvedPath.absolutePath)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (!stat) {
    return [
      `Referenced path: ${resolvedPath.relativePath}`,
      "The path does not exist in the current workspace.",
    ].join("\n");
  }

  if (stat.type === "Directory") {
    const entries = yield* services.fileSystem
      .readDirectory(resolvedPath.absolutePath, { recursive: true })
      .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));
    const visibleEntries = entries
      .map((entry) => entry.replaceAll("\\", "/"))
      .toSorted((left, right) => left.localeCompare(right))
      .slice(0, MAX_DIRECTORY_ENTRIES);
    return [
      `Referenced directory: ${resolvedPath.relativePath}`,
      `Resolved path: ${resolvedPath.absolutePath}`,
      visibleEntries.length > 0
        ? `Directory listing (${visibleEntries.length}${entries.length > visibleEntries.length ? "+" : ""} entries):\n${visibleEntries.map((entry) => `- ${entry}`).join("\n")}`
        : "The directory is empty or could not be listed.",
    ].join("\n");
  }

  const fileContent = yield* services.fileSystem
    .readFileString(resolvedPath.absolutePath)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (fileContent === null) {
    return [
      `Referenced file: ${resolvedPath.relativePath}`,
      `Resolved path: ${resolvedPath.absolutePath}`,
      "The file could not be read as text.",
    ].join("\n");
  }

  return [
    `Referenced file: ${resolvedPath.relativePath}`,
    `Resolved path: ${resolvedPath.absolutePath}`,
    "File contents:",
    truncateText(fileContent, MAX_TEXT_BLOCK_CHARS),
  ].join("\n");
});

export const expandProviderInputMentions = (
  services: ProviderCommandReactorInputExpansionServices,
) =>
  Effect.fn("expandProviderInputMentions")(function* (input: {
    readonly messageText: string;
    readonly thread: OrchestrationThread;
    readonly workspaceRoot?: string;
  }) {
    const mentions = collectCompactMentions(input.messageText).slice(0, MAX_REFERENCE_BLOCKS);
    if (mentions.length === 0) {
      return input.messageText;
    }

    const catalog = yield* services.discoveryRegistry.getCatalog;

    const referenceBlocks = yield* Effect.forEach(mentions, (mention) => {
      if (mention.kind === "path") {
        if (!input.workspaceRoot) {
          return Effect.succeed(
            [
              `Referenced path: ${mention.path}`,
              "No workspace root was available, so the path could not be resolved.",
            ].join("\n"),
          );
        }
        return buildPathReferenceBlock(services, {
          rawPath: mention.path,
          workspaceRoot: input.workspaceRoot,
        });
      }

      const resolution = resolveDiscoveryEntry({
        entries: mention.kind === "agent" ? catalog.agents : catalog.skills,
        name: mention.name,
        preferredProvider: input.thread.modelSelection.provider,
      });

      if (resolution.status === "missing") {
        return Effect.succeed(
          [
            `Referenced ${mention.kind}: ${mention.name}`,
            `No discovered ${mention.kind} matched this name.`,
          ].join("\n"),
        );
      }

      if (resolution.status === "ambiguous") {
        return Effect.succeed(
          [
            `Referenced ${mention.kind}: ${mention.name}`,
            `This ${mention.kind} name matched multiple providers: ${resolution.entries.map((entry) => entry.provider).join(", ")}.`,
            `The active thread provider is '${input.thread.modelSelection.provider}', but no exact match was available there.`,
          ].join("\n"),
        );
      }

      return buildDiscoveryReferenceBlock(services, {
        kind: mention.kind,
        entry: resolution.entry,
      });
    });

    return truncateText(
      [
        "Original user message:",
        input.messageText,
        "",
        "Resolved compact references from the user message. Use them as active context when answering:",
        ...referenceBlocks,
      ].join("\n\n"),
      PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
    );
  });
