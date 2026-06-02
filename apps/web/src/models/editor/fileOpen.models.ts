import type { NativeApi } from "@bigbud/contracts";
import { openInPreferredEditor } from "./preferences.models";

const CODE_RELATED_EXTENSIONS = new Set([
  ".astro",
  ".c",
  ".cjs",
  ".cmake",
  ".cpp",
  ".cs",
  ".cts",
  ".css",
  ".csv",
  ".diff",
  ".dockerfile",
  ".env",
  ".fish",
  ".go",
  ".graphql",
  ".h",
  ".hh",
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
  ".mts",
  ".patch",
  ".php",
  ".plist",
  ".proto",
  ".ps1",
  ".py",
  ".rb",
  ".rst",
  ".rs",
  ".sass",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".toml",
  ".txt",
  ".ts",
  ".tsx",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);
const CODE_RELATED_FILENAMES = new Set([
  ".env",
  ".env.local",
  ".npmrc",
  ".prettierrc",
  ".gitignore",
  "dockerfile",
  "gemfile",
  "license",
  "makefile",
  "rakefile",
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
