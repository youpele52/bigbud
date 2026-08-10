import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

import type { PluginCatalogItem } from "@bigbud/contracts";

const MAX_STRING = 4_000;
const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg"]);

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_STRING
    ? value.trim()
    : undefined;
}

function safeRelativePath(value: unknown): string | undefined {
  const candidate = text(value);
  return candidate &&
    !candidate.startsWith("/") &&
    !candidate.startsWith("\\") &&
    !candidate.split(/[\\/]/).includes("..")
    ? candidate
    : undefined;
}

export function normalizePluginManifest(input: {
  readonly marketplaceName: string;
  readonly commit: string;
  readonly category?: string;
  readonly sourcePath: string;
  readonly manifest: unknown;
}): PluginCatalogItem | { readonly reason: string; readonly unsupported?: boolean } {
  if (!input.manifest || typeof input.manifest !== "object") return { reason: "invalid manifest" };
  const manifest = input.manifest as Record<string, unknown>;
  const name = text(manifest.name);
  if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || name !== input.marketplaceName) {
    return { reason: "invalid or mismatched plugin name" };
  }
  for (const field of ["apps", "mcpServers", "mcp", "hooks", "browserExtensions", "schedules"]) {
    if (field in manifest) return { reason: `unsupported component: ${field}`, unsupported: true };
  }
  const skills =
    typeof manifest.skills === "string"
      ? [manifest.skills]
      : Array.isArray(manifest.skills)
        ? manifest.skills
        : [];
  if (skills.length === 0 || skills.length > 100) return { reason: "missing skills root" };
  const components = skills
    .map((skill) => {
      const raw = typeof skill === "string" ? { path: skill } : skill;
      if (!raw || typeof raw !== "object") return undefined;
      const record = raw as Record<string, unknown>;
      const path = safeRelativePath(record.path);
      if (!path) return undefined;
      const skillName = text(record.name) ?? path.split("/").findLast(Boolean);
      const displayName = text(record.displayName);
      const description = text(record.description);
      return skillName
        ? {
            kind: "skill" as const,
            name: skillName,
            ...(displayName ? { displayName } : {}),
            ...(description ? { description } : {}),
            path,
          }
        : undefined;
    })
    .filter((skill): skill is NonNullable<typeof skill> => skill !== undefined);
  if (components.length !== skills.length) return { reason: "invalid skills root" };
  const interfaceValue =
    manifest.interface && typeof manifest.interface === "object"
      ? (manifest.interface as Record<string, unknown>)
      : manifest;
  const assets = {
    composerIcon: safeRelativePath(interfaceValue.composerIcon),
    logo: safeRelativePath(interfaceValue.logo),
    logoDark: safeRelativePath(interfaceValue.logoDark),
  };
  return {
    id: `openai-public:${name}`,
    name,
    ...(text(manifest.version) ? { version: text(manifest.version) } : {}),
    commit: input.commit,
    sourcePath: input.sourcePath,
    presentation: {
      displayName: text(interfaceValue.displayName) ?? name,
      ...(text(interfaceValue.shortDescription)
        ? { shortDescription: text(interfaceValue.shortDescription) }
        : {}),
      ...(text(interfaceValue.longDescription)
        ? { longDescription: text(interfaceValue.longDescription) }
        : {}),
      ...(text(interfaceValue.developer) ? { developer: text(interfaceValue.developer) } : {}),
      ...((text(interfaceValue.category) ?? input.category)
        ? { category: text(interfaceValue.category) ?? input.category }
        : {}),
      ...(text(interfaceValue.defaultPrompt)
        ? { defaultPrompt: text(interfaceValue.defaultPrompt) }
        : {}),
      ...(text(interfaceValue.website) ? { website: text(interfaceValue.website) } : {}),
      ...(text(interfaceValue.privacy) ? { privacy: text(interfaceValue.privacy) } : {}),
      ...(text(interfaceValue.terms) ? { terms: text(interfaceValue.terms) } : {}),
      assets,
    },
    components,
    compatibility: "compatible",
  };
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !path.includes("../") && !path.includes("..\\"));
}

/** Validates a copied package without following untrusted links or special files. */
export async function validatePluginPackage(root: string, item: PluginCatalogItem): Promise<void> {
  const realRoot = await realpath(root);
  let files = 0;
  let bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = resolve(directory, entry.name);
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
        throw new Error("Plugin package contains an unsafe file type");
      }
      if (metadata.isDirectory()) {
        await visit(candidate);
        continue;
      }
      files += 1;
      bytes += metadata.size;
      if (files > MAX_FILES || metadata.size > MAX_FILE_BYTES || bytes > MAX_PACKAGE_BYTES) {
        throw new Error("Plugin package exceeds size limits");
      }
      const resolved = await realpath(candidate);
      if (!isInside(realRoot, resolved)) throw new Error("Plugin package escapes its root");
    }
  };
  await visit(realRoot);
  for (const component of item.components) {
    const skillRoot = resolve(realRoot, component.path);
    if (!isInside(realRoot, skillRoot)) throw new Error("Plugin skill root escapes package");
    const skillStat = await stat(skillRoot);
    if (!skillStat.isDirectory()) throw new Error("Plugin skill root is missing");
  }
  for (const asset of Object.values(item.presentation.assets)) {
    if (!asset) continue;
    const extension = extname(asset).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) throw new Error("Plugin asset format is not allowed");
    const path = resolve(realRoot, asset);
    if (!isInside(realRoot, path)) throw new Error("Plugin asset escapes package");
    const assetInfo = await lstat(path);
    if (!assetInfo.isFile() || assetInfo.size > MAX_ASSET_BYTES) {
      throw new Error("Plugin asset is invalid or too large");
    }
  }
}
