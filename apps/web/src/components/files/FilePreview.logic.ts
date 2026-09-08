import { isCodeRelatedFilePath } from "../../models/editor";

export const FILE_PREVIEW_LINE_HEIGHT = 20;

const MARKDOWN_FILE_EXTENSIONS = new Set([".md", ".mdx"]);
const PREVIEW_LANGUAGE_BY_FILENAME = new Map<string, string>([
  [".dockerignore", "ini"],
  [".editorconfig", "ini"],
  [".eslintignore", "ini"],
  [".gitignore", "ini"],
  [".npmignore", "ini"],
  [".npmrc", "properties"],
  [".prettierignore", "ini"],
  [".prettierrc", "jsonc"],
  [".yarnrc", "properties"],
  ["authors", "markdown"],
  ["changelog", "markdown"],
  ["contributors", "markdown"],
  ["gemfile", "ruby"],
  ["license", "markdown"],
  ["makefile", "makefile"],
  ["notice", "markdown"],
  ["rakefile", "ruby"],
  ["readme", "markdown"],
]);
const PREVIEW_LANGUAGE_BY_EXTENSION = new Map<string, string>([
  ["cfg", "ini"],
  ["cnf", "ini"],
  ["conf", "ini"],
  ["env", "dotenv"],
  ["ini", "ini"],
  ["log", "log"],
  ["properties", "properties"],
  ["text", "markdown"],
  ["txt", "markdown"],
]);

interface PreviewLoadingState {
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

export function getFilePreviewWatchRelativePath(relativePath: string): string | undefined {
  const pathSegments = relativePath.split("/").filter(Boolean);
  if (pathSegments.length <= 1) {
    return undefined;
  }

  return pathSegments.slice(0, -1).join("/");
}

export function shouldShowPreviewLoading(state: PreviewLoadingState): boolean {
  return state.loading && !state.loaded && state.error === null;
}

export function clampPreviewTargetLine(
  targetLine: number | undefined,
  totalLines: number,
): number | null {
  if (!targetLine || !Number.isFinite(targetLine) || totalLines <= 0) {
    return null;
  }

  return Math.max(1, Math.min(targetLine, totalLines));
}

export function getPreviewScrollTop(
  targetLine: number | undefined,
  totalLines: number,
  containerHeight: number,
  lineHeight = FILE_PREVIEW_LINE_HEIGHT,
): number | null {
  const clampedLine = clampPreviewTargetLine(targetLine, totalLines);
  if (clampedLine === null) {
    return null;
  }

  return Math.max(0, clampedLine * lineHeight - containerHeight / 2);
}

function fileNameFromPath(pathValue: string): string {
  const segments = pathValue.split(/[\\/]/);
  return segments.at(-1) ?? pathValue;
}

function previewLanguageOverride(pathValue: string): string | null {
  const name = fileNameFromPath(pathValue).toLowerCase();
  if (name === "dockerfile" || name.startsWith("dockerfile-") || name.startsWith("dockerfile.")) {
    return "dockerfile";
  }
  if (name === ".env" || name.startsWith(".env.")) return "dotenv";
  const fromFilename = PREVIEW_LANGUAGE_BY_FILENAME.get(name);
  if (fromFilename) return fromFilename;
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return PREVIEW_LANGUAGE_BY_EXTENSION.get(extension) ?? null;
}

export function buildAbsolutePreviewPath(cwd: string, relativePath: string): string {
  if (relativePath.length === 0) {
    return cwd;
  }
  return `${cwd.replace(/\/+$/, "")}/${relativePath.replace(/^\/+/, "")}`;
}

export function inferPreviewLanguage(pathValue: string): string {
  const name = fileNameFromPath(pathValue).toLowerCase();
  const override = previewLanguageOverride(pathValue);
  if (override) return override;
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "text";
  if (extension === "cts" || extension === "mts") return "ts";
  if (extension === "mdx") return "md";
  if (extension === "yml") return "yaml";
  if (extension === "ps1") return "powershell";
  if (extension === "sh" || extension === "bash" || extension === "zsh") return "shellscript";
  return extension || "text";
}

export function shouldSyntaxHighlightPreviewPath(pathValue: string): boolean {
  return previewLanguageOverride(pathValue) !== null || isCodeRelatedFilePath(pathValue);
}

export function buildFilePreviewBreadcrumb(
  projectName: string | undefined,
  cwd: string,
  relativePath: string,
) {
  const rootName = projectName ?? fileNameFromPath(cwd);
  return [rootName, ...relativePath.split("/").filter(Boolean)].map((label, index, parts) => ({
    id: parts.slice(0, index + 1).join("/"),
    label,
  }));
}

export function isMarkdownFilePath(pathValue: string): boolean {
  const name = fileNameFromPath(pathValue).toLowerCase();
  for (const extension of MARKDOWN_FILE_EXTENSIONS) {
    if (name.endsWith(extension)) {
      return true;
    }
  }
  return false;
}
