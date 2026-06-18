import { join, relative, resolve } from "node:path";

export const TEACH_LEARNING_ROOT_SEGMENT = "bigbud-learn";
export const TEACH_SKILL_NAME = "teach";

export const TEACH_PROJECT_ROOT_FILES = [
  "MISSION.md",
  "NOTES.md",
  "GLOSSARY.md",
  "RESOURCES.md",
] as const;

export const TEACH_PROJECT_ROOT_DIRS = ["learning-records", "lessons", "reference"] as const;

export function resolveTeachLearningRoot(defaultChatCwd: string): string {
  return join(defaultChatCwd, TEACH_LEARNING_ROOT_SEGMENT);
}

export function resolveTeachProjectPath(defaultChatCwd: string, topicSlug: string): string {
  return join(resolveTeachLearningRoot(defaultChatCwd), topicSlug);
}

export function slugifyTeachTopic(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return slug.length > 0 ? slug : "learning-project";
}

function trimToUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function extractTeachTopicFromMessage(messageText: string): string | undefined {
  const slashMatch = /^\/skills?\s+teach(?:\s+([\s\S]+))?$/i.exec(messageText.trim());
  if (slashMatch) {
    return trimToUndefined(slashMatch[1] ?? "");
  }

  return undefined;
}

export function isTeachSkillName(name: string): boolean {
  return name.trim().toLowerCase() === TEACH_SKILL_NAME;
}

export function readMissionTitle(missionContent: string): string | undefined {
  const headingLine = missionContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("# Mission:"));

  if (!headingLine) {
    return undefined;
  }

  const title = headingLine.replace(/^#\s*Mission:\s*/i, "").trim();
  return title.length > 0 ? title : undefined;
}

export function isSameDirectory(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

/** Returns the project folder when `targetPath` is inside `<learningRoot>/<slug>/`. */
export function getTeachProjectFolderForPath(
  learningRootPath: string,
  targetPath: string,
): string | undefined {
  const learningRoot = resolve(learningRootPath);
  const target = resolve(targetPath);
  const relativePath = relative(learningRoot, target);

  if (relativePath === "" || relativePath.startsWith("..")) {
    return undefined;
  }

  const projectSlug = relativePath.split(/[/\\]/)[0];
  if (!projectSlug) {
    return undefined;
  }

  return join(learningRoot, projectSlug);
}
