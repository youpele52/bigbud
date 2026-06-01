import type { NativeApi } from "@bigbud/contracts";
import { openInPreferredEditor } from "./preferences.models";

const CODE_RELATED_EXTENSIONS = new Set([
  ".astro",
  ".c",
  ".cjs",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".graphql",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".kt",
  ".kts",
  ".lua",
  ".md",
  ".mdx",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".toml",
  ".ts",
  ".tsx",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
]);
const CODE_RELATED_FILENAMES = new Set([
  ".env",
  ".gitignore",
  "dockerfile",
  "license",
  "makefile",
  "readme",
]);
const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;

function basenameOfPath(pathValue: string): string {
  const segments = pathValue.split(/[\\/]/);
  return segments.at(-1) ?? pathValue;
}

export function stripPathPositionSuffix(pathValue: string): string {
  return pathValue.replace(POSITION_SUFFIX_PATTERN, "");
}

export function isCodeRelatedFilePath(pathValue: string): boolean {
  const name = basenameOfPath(stripPathPositionSuffix(pathValue));
  const lowerName = name.toLowerCase();
  if (CODE_RELATED_FILENAMES.has(lowerName)) return true;
  const extensionStart = lowerName.lastIndexOf(".");
  if (extensionStart <= 0) return false;
  return CODE_RELATED_EXTENSIONS.has(lowerName.slice(extensionStart));
}

export async function openPathInPreferredApp(api: NativeApi, targetPath: string): Promise<void> {
  if (isCodeRelatedFilePath(targetPath)) {
    await openInPreferredEditor(api, targetPath);
    return;
  }
  await api.shell.openPath(stripPathPositionSuffix(targetPath));
}
