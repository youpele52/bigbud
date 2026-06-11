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
  ".ipynb",
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

export interface PathPosition {
  line: number;
  column: number | null;
}

function basenameOfPath(pathValue: string): string {
  const segments = pathValue.split(/[\\/]/);
  return segments.at(-1) ?? pathValue;
}

export function stripPathPositionSuffix(pathValue: string): string {
  return pathValue.replace(POSITION_SUFFIX_PATTERN, "");
}

export function parsePathPositionSuffix(pathValue: string): PathPosition | null {
  const match = pathValue.match(/:(\d+)(?::(\d+))?$/);
  if (!match?.[1]) {
    return null;
  }

  const line = Number.parseInt(match[1], 10);
  if (!Number.isFinite(line) || line <= 0) {
    return null;
  }

  const columnValue = match[2] ? Number.parseInt(match[2], 10) : null;
  const column =
    columnValue !== null && Number.isFinite(columnValue) && columnValue > 0 ? columnValue : null;

  return { line, column };
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
