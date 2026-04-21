import * as OS from "node:os";
import type {
  ProviderKind,
  ServerDiscoveredAgent,
  ServerDiscoveredSkill,
  ServerDiscoveryCatalog,
} from "@bigbud/contracts";
import { Effect, Equal, FileSystem, Layer, Path, PubSub, Ref, Stream } from "effect";

import { ServerConfig } from "../../startup/config";
import { ServerSettingsService } from "../../ws/serverSettings";
import { DiscoveryRegistry, type DiscoveryRegistryShape } from "../Services/DiscoveryRegistry";
import {
  buildDiscoveryConfigDescriptors,
  buildDiscoveryFileDescriptors,
  type DiscoveryFileDescriptor,
} from "./DiscoveryRegistry.descriptors.ts";

interface ParsedDiscoveryFileEntry {
  readonly kind: DiscoveryFileDescriptor["kind"];
  readonly entry: ServerDiscoveredAgent | ServerDiscoveredSkill;
}

const EMPTY_DISCOVERY: ServerDiscoveryCatalog = {
  agents: [],
  skills: [],
};

const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;
const FRONTMATTER_NAME_REGEX = /^(?:name|title):\s*(.+)$/im;
const FRONTMATTER_DESCRIPTION_REGEX = /^(?:description|summary):\s*(.+)$/im;
const HEADER_NAME_REGEX = /^#\s+(.+)$/m;
const OPENCODE_AGENT_SECTION_REGEX = /^agent\s*=\s*\{([\s\S]*?)\}/gm;
const OPENCODE_AGENT_NAME_REGEX = /name\s*=\s*"([^"]+)"/;
const OPENCODE_AGENT_DESCRIPTION_REGEX = /description\s*=\s*"([^"]+)"/;
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

function inferNameFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const lastSegment = normalized.split("/").at(-1) ?? normalized;
  if (lastSegment === "SKILL.md") {
    return normalized.split("/").at(-2) ?? "skill";
  }
  return lastSegment.replace(/\.(md|markdown|ya?ml|toml|json)$/i, "");
}

function buildDiscoveryId(provider: ProviderKind, kind: "agent" | "skill", name: string): string {
  return `${provider}:${kind}:${name.trim().toLowerCase()}`;
}

function parseFrontmatter(content: string): { name?: string; description?: string } {
  const frontmatter = FRONTMATTER_REGEX.exec(content)?.[1];
  if (!frontmatter) {
    return {};
  }
  const name = trimToUndefined(FRONTMATTER_NAME_REGEX.exec(frontmatter)?.[1]);
  const description = trimToUndefined(FRONTMATTER_DESCRIPTION_REGEX.exec(frontmatter)?.[1]);
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
}

function parseMarkdownDiscovery(
  content: string,
  fallbackName: string,
): {
  name: string;
  description?: string;
} {
  const frontmatter = parseFrontmatter(content);
  const headingName = trimToUndefined(HEADER_NAME_REGEX.exec(content)?.[1]);
  const simpleName = trimToUndefined(SIMPLE_NAME_REGEX.exec(content)?.[1]);
  const simpleDescription = trimToUndefined(SIMPLE_DESCRIPTION_REGEX.exec(content)?.[1]);
  const name = frontmatter.name ?? headingName ?? simpleName ?? fallbackName;
  const description = frontmatter.description ?? simpleDescription;
  return {
    name,
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

function parseDiscoveryFile(
  input: DiscoveryFileDescriptor & { readonly content: string },
): ParsedDiscoveryFileEntry {
  const fallbackName = inferNameFromPath(input.path);
  const parsed =
    input.provider === "codex" && input.kind === "agent"
      ? parseCodexTomlAgent(input.content, fallbackName)
      : input.provider === "claudeAgent" && input.kind === "agent" && input.path.endsWith(".json")
        ? parseClaudeJsonAgent(input.content, fallbackName)
        : parseMarkdownDiscovery(input.content, fallbackName);
  const name = parsed.name.trim();
  const base = {
    id: buildDiscoveryId(input.provider, input.kind, name),
    provider: input.provider,
    name,
    source: input.source,
    ...(parsed.description ? { description: parsed.description } : {}),
    sourcePath: input.path,
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

function parseOpencodeConfigAgents(
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
        name,
        source: configPath.includes(`${OS.homedir()}/`) ? ("user" as const) : ("project" as const),
        ...(description ? { description } : {}),
        sourcePath: configPath,
      } satisfies ServerDiscoveredAgent,
    ];
  });
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

function mergeEntries<T extends ServerDiscoveredAgent | ServerDiscoveredSkill>(
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

const collectPathsRecursive = Effect.fn("DiscoveryRegistry.collectPathsRecursive")(function* (
  fs: FileSystem.FileSystem,
  rootPath: string,
  predicate: (path: string) => boolean,
) {
  const exists = yield* fs.exists(rootPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return [] as Array<string>;
  }
  const entries = yield* fs
    .readDirectory(rootPath, { recursive: true })
    .pipe(Effect.orElseSucceed(() => [] as Array<string>));
  return entries
    .map((entry) => `${rootPath}/${entry}`.replace(/\/+/g, "/"))
    .filter((p) => !p.split("/").includes("node_modules"))
    .filter(predicate);
});

export const haveDiscoveryChanged = (
  previousCatalog: ServerDiscoveryCatalog,
  nextCatalog: ServerDiscoveryCatalog,
): boolean => !Equal.equals(previousCatalog, nextCatalog);

const makeDiscoveryRegistry = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ServerDiscoveryCatalog>(),
    PubSub.shutdown,
  );

  const resolveKnownFileDescriptors = () =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      return buildDiscoveryFileDescriptors({
        path,
        cwd: config.cwd,
        settings,
      });
    });

  const resolveConfigDescriptors = () =>
    Effect.succeed(
      buildDiscoveryConfigDescriptors({
        path,
        cwd: config.cwd,
      }),
    );

  const scanDiscoveryFiles = () =>
    Effect.gen(function* () {
      const descriptors = yield* resolveKnownFileDescriptors();
      const resolvedPaths = yield* Effect.forEach(
        descriptors,
        (descriptor) =>
          collectPathsRecursive(fs, descriptor.path, (absolutePath) => {
            if (descriptor.kind === "skill") {
              return absolutePath.endsWith("/SKILL.md");
            }
            return /\.(md|markdown|json|toml|ya?ml)$/i.test(absolutePath);
          }).pipe(
            Effect.map((paths) =>
              paths.map((resolvedPath) => ({ ...descriptor, path: resolvedPath })),
            ),
          ),
        { concurrency: "unbounded" },
      );
      return resolvedPaths.flat();
    });

  const loadDiscoveryCatalog = () =>
    Effect.gen(function* () {
      const [fileDescriptors, configDescriptors] = yield* Effect.all(
        [scanDiscoveryFiles(), resolveConfigDescriptors()],
        { concurrency: "unbounded" },
      );

      const discoveredFileEntries = yield* Effect.forEach(
        fileDescriptors,
        (descriptor) =>
          fs.readFileString(descriptor.path).pipe(
            Effect.map((content) => parseDiscoveryFile({ ...descriptor, content })),
            Effect.catch(() => Effect.succeed(null)),
          ),
        { concurrency: "unbounded" },
      );

      const discoveredConfigAgents = yield* Effect.forEach(
        configDescriptors,
        (descriptor) =>
          fs.readFileString(descriptor.path).pipe(
            Effect.map((content) => parseOpencodeConfigAgents(descriptor.path, content)),
            Effect.catch(() => Effect.succeed([] as ReadonlyArray<ServerDiscoveredAgent>)),
          ),
        { concurrency: "unbounded" },
      );

      const agentEntries: Array<ServerDiscoveredAgent> = [];
      const skillEntries: Array<ServerDiscoveredSkill> = [];

      for (const entry of discoveredFileEntries) {
        if (!entry) {
          continue;
        }
        if (entry.kind === "agent") {
          agentEntries.push(entry.entry as ServerDiscoveredAgent);
          continue;
        }
        skillEntries.push(entry.entry as ServerDiscoveredSkill);
      }

      for (const entries of discoveredConfigAgents) {
        agentEntries.push(...entries);
      }

      return {
        agents: mergeEntries(agentEntries),
        skills: mergeEntries(skillEntries),
      } satisfies ServerDiscoveryCatalog;
    });

  const catalogRef = yield* Ref.make<ServerDiscoveryCatalog>(yield* loadDiscoveryCatalog());

  const syncCatalog = (options?: { readonly publish?: boolean }) =>
    Effect.gen(function* () {
      const previousCatalog = yield* Ref.get(catalogRef);
      const nextCatalog = yield* loadDiscoveryCatalog().pipe(
        Effect.catch(() => Effect.succeed(EMPTY_DISCOVERY)),
      );
      yield* Ref.set(catalogRef, nextCatalog);
      if (options?.publish !== false && haveDiscoveryChanged(previousCatalog, nextCatalog)) {
        yield* PubSub.publish(changesPubSub, nextCatalog);
      }
      return nextCatalog;
    });

  yield* Stream.runForEach(serverSettings.streamChanges, () => syncCatalog()).pipe(
    Effect.forkScoped,
  );

  return {
    getCatalog: syncCatalog({ publish: false }),
    refresh: (_provider?: ProviderKind) => syncCatalog(),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies DiscoveryRegistryShape;
});

export const DiscoveryRegistryLive = Layer.effect(DiscoveryRegistry, makeDiscoveryRegistry);
