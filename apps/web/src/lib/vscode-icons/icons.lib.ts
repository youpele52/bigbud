import { generateManifest, type Manifest } from "material-icon-theme";

const MATERIAL_ICON_THEME_VERSION = "5.39.0";
const MATERIAL_ICON_THEME_BASE_URL = `https://cdn.jsdelivr.net/npm/material-icon-theme@${MATERIAL_ICON_THEME_VERSION}/icons`;
const manifest = generateManifest({ folders: { theme: "specific" } });
const darkFileNames = lowercaseLookup(manifest.fileNames);
const lightFileNames = lowercaseLookup(manifest.light?.fileNames);
const darkFileExtensions = lowercaseLookup(manifest.fileExtensions);
const lightFileExtensions = lowercaseLookup(manifest.light?.fileExtensions);
const darkFolderNames = lowercaseLookup(manifest.folderNames);
const lightFolderNames = lowercaseLookup(manifest.light?.folderNames);
const darkLanguageIds = lowercaseLookup(manifest.languageIds);
const lightLanguageIds = lowercaseLookup(manifest.light?.languageIds);

export function basenameOfPath(pathValue: string): string {
  const slashIndex = pathValue.lastIndexOf("/");
  if (slashIndex === -1) return pathValue;
  return pathValue.slice(slashIndex + 1);
}

export function inferEntryKindFromPath(pathValue: string): "file" | "directory" {
  const base = basenameOfPath(pathValue);
  if (base.startsWith(".") && !base.slice(1).includes(".")) {
    return "directory";
  }
  if (base.includes(".")) {
    return "file";
  }
  return "directory";
}

function lowercaseLookup(values: Record<string, string> | undefined): Record<string, string> {
  const lookup: Record<string, string> = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    lookup[key.toLowerCase()] = value;
  }
  return lookup;
}

function extensionCandidates(fileName: string): string[] {
  const candidates: string[] = [];
  let dotIndex = fileName.indexOf(".");
  while (dotIndex !== -1 && dotIndex < fileName.length - 1) {
    candidates.push(fileName.slice(dotIndex + 1));
    dotIndex = fileName.indexOf(".", dotIndex + 1);
  }
  return candidates;
}

function resolveDefinition(
  pathValue: string,
  kind: "file" | "directory",
  theme: "light" | "dark",
): string {
  const name = basenameOfPath(pathValue).toLowerCase();
  const themedManifest = theme === "light" ? (manifest.light ?? manifest) : manifest;

  if (kind === "directory") {
    const folders = theme === "light" ? lightFolderNames : darkFolderNames;
    const definition = folders[name] ?? darkFolderNames[name];
    return definition ?? themedManifest.folder ?? manifest.folder ?? "folder";
  }

  const fileNames = theme === "light" ? lightFileNames : darkFileNames;
  const fileExtensions = theme === "light" ? lightFileExtensions : darkFileExtensions;
  const languageIds = theme === "light" ? lightLanguageIds : darkLanguageIds;
  const fromFileName = fileNames[name] ?? darkFileNames[name];
  if (fromFileName) return fromFileName;

  for (const extension of extensionCandidates(name)) {
    const definition = fileExtensions[extension] ?? darkFileExtensions[extension];
    if (definition) return definition;
  }

  const fromLanguage = languageIds[name.split(".").at(-1) ?? ""];
  return fromLanguage ?? themedManifest.file ?? manifest.file ?? "file";
}

function iconFilename(definition: string): string | null {
  const iconPath = (manifest as Manifest).iconDefinitions?.[definition]?.iconPath;
  if (!iconPath) return null;
  return iconPath.slice(iconPath.lastIndexOf("/") + 1);
}

export function getVscodeIconUrlForEntry(
  pathValue: string,
  kind: "file" | "directory",
  theme: "light" | "dark",
): string {
  const definition = resolveDefinition(pathValue, kind, theme);
  const filename = iconFilename(definition) ?? (kind === "directory" ? "folder.svg" : "file.svg");
  return `${MATERIAL_ICON_THEME_BASE_URL}/${filename}`;
}
