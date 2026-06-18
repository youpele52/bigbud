import type { TeachLearningProject, TeachListProjectsResult } from "@bigbud/contracts";
import { Effect, FileSystem, Option } from "effect";
import { join } from "node:path";

import { isGitRepository } from "../git/Utils.ts";
import {
  extractTeachTopicFromMessage,
  readMissionTitle,
  resolveTeachLearningRoot,
  resolveTeachProjectPath,
  slugifyTeachTopic,
  TEACH_PROJECT_ROOT_DIRS,
  TEACH_PROJECT_ROOT_FILES,
  isSameDirectory,
} from "./TeachLearningProjects.utils.ts";

function resolveMtime(stat: { readonly mtime: Date | Option.Option<Date> }): Date {
  return Option.isOption(stat.mtime) ? Option.getOrElse(stat.mtime, () => new Date()) : stat.mtime;
}

function isLearningProjectDirectory(entryNames: ReadonlyArray<string>): boolean {
  return entryNames.includes("MISSION.md") || entryNames.includes("lessons");
}

const readMissionSummary = Effect.fn("readMissionSummary")(function* (
  fileSystem: FileSystem.FileSystem,
  projectPath: string,
) {
  const missionPath = join(projectPath, "MISSION.md");
  const content = yield* fileSystem
    .readFileString(missionPath)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (!content) {
    return undefined;
  }

  return readMissionTitle(content);
});

const readProjectUpdatedAt = Effect.fn("readProjectUpdatedAt")(function* (
  fileSystem: FileSystem.FileSystem,
  projectPath: string,
) {
  const missionStat = yield* fileSystem
    .stat(join(projectPath, "MISSION.md"))
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (missionStat?.mtime) {
    return resolveMtime(missionStat).toISOString();
  }

  const lessonsStat = yield* fileSystem
    .stat(join(projectPath, "lessons"))
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (lessonsStat?.mtime) {
    return resolveMtime(lessonsStat).toISOString();
  }

  return undefined;
});

const listLearningProjectSummaries = Effect.fn("listLearningProjectSummaries")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly learningRootPath: string;
}) {
  const entries = yield* input.fileSystem
    .readDirectory(input.learningRootPath)
    .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));

  const projects: Array<TeachLearningProject> = [];
  for (const entry of entries.toSorted((left, right) => left.localeCompare(right))) {
    const absolutePath = join(input.learningRootPath, entry);
    const stat = yield* input.fileSystem
      .stat(absolutePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!stat || stat.type !== "Directory") {
      continue;
    }

    const childEntries = yield* input.fileSystem
      .readDirectory(absolutePath)
      .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));
    if (!isLearningProjectDirectory(childEntries)) {
      continue;
    }

    const title = yield* readMissionSummary(input.fileSystem, absolutePath);
    const updatedAt = yield* readProjectUpdatedAt(input.fileSystem, absolutePath);
    projects.push({
      slug: entry,
      absolutePath,
      ...(title ? { title } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    });
  }

  return projects;
});

export const ensureTeachLearningRoot = Effect.fn("ensureTeachLearningRoot")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly defaultChatCwd: string;
}) {
  const learningRootPath = resolveTeachLearningRoot(input.defaultChatCwd);
  yield* input.fileSystem
    .makeDirectory(learningRootPath, { recursive: true })
    .pipe(Effect.catch(() => Effect.void));
  return learningRootPath;
});

export const ensureTeachProjectDirectory = Effect.fn("ensureTeachProjectDirectory")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly defaultChatCwd: string;
    readonly topicSlug: string;
  }) {
    const learningRootPath = yield* ensureTeachLearningRoot({
      fileSystem: input.fileSystem,
      defaultChatCwd: input.defaultChatCwd,
    });
    const projectPath = join(learningRootPath, input.topicSlug);
    yield* input.fileSystem
      .makeDirectory(projectPath, { recursive: true })
      .pipe(Effect.catch(() => Effect.void));
    return projectPath;
  },
);

const detectMisplacedTeachArtifactsAtChatRoot = Effect.fn(
  "detectMisplacedTeachArtifactsAtChatRoot",
)(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly defaultChatCwd: string;
}) {
  const misplaced: Array<string> = [];

  for (const fileName of TEACH_PROJECT_ROOT_FILES) {
    const absolutePath = join(input.defaultChatCwd, fileName);
    const stat = yield* input.fileSystem
      .stat(absolutePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (stat?.type === "File") {
      misplaced.push(absolutePath);
    }
  }

  for (const dirName of TEACH_PROJECT_ROOT_DIRS) {
    const absolutePath = join(input.defaultChatCwd, dirName);
    const stat = yield* input.fileSystem
      .stat(absolutePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (stat?.type === "Directory") {
      misplaced.push(`${absolutePath}/`);
    }
  }

  return misplaced;
});

export const listTeachLearningProjects = Effect.fn("listTeachLearningProjects")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly defaultChatCwd: string;
}) {
  const learningRootPath = yield* ensureTeachLearningRoot(input);
  const projects = yield* listLearningProjectSummaries({
    fileSystem: input.fileSystem,
    learningRootPath,
  });

  return {
    defaultChatCwd: input.defaultChatCwd,
    learningRootPath,
    projects,
  } satisfies TeachListProjectsResult;
});

export const buildTeachSkillRuntimeContext = Effect.fn("buildTeachSkillRuntimeContext")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly defaultChatCwd: string;
    readonly messageText: string;
    readonly threadWorkspaceRoot?: string;
  }) {
    const catalog = yield* listTeachLearningProjects({
      fileSystem: input.fileSystem,
      defaultChatCwd: input.defaultChatCwd,
    });

    const topic = extractTeachTopicFromMessage(input.messageText);
    const suggestedSlug = topic ? slugifyTeachTopic(topic) : undefined;
    let suggestedProjectPath =
      suggestedSlug !== undefined
        ? resolveTeachProjectPath(input.defaultChatCwd, suggestedSlug)
        : undefined;

    if (suggestedSlug) {
      suggestedProjectPath = yield* ensureTeachProjectDirectory({
        fileSystem: input.fileSystem,
        defaultChatCwd: input.defaultChatCwd,
        topicSlug: suggestedSlug,
      });
    }

    const misplacedArtifacts = yield* detectMisplacedTeachArtifactsAtChatRoot({
      fileSystem: input.fileSystem,
      defaultChatCwd: input.defaultChatCwd,
    });

    const threadWorkspaceRoot = input.threadWorkspaceRoot?.trim();
    const threadIsDefaultChatFolder =
      threadWorkspaceRoot !== undefined &&
      threadWorkspaceRoot.length > 0 &&
      isSameDirectory(threadWorkspaceRoot, catalog.defaultChatCwd);
    const threadIsGitRepo =
      threadWorkspaceRoot !== undefined &&
      threadWorkspaceRoot.length > 0 &&
      !threadIsDefaultChatFolder &&
      isGitRepository(threadWorkspaceRoot);

    const lines = [
      "bigbud teach runtime context (authoritative — do not guess these paths):",
      `Default chat folder: ${catalog.defaultChatCwd}`,
      `Learning projects root: ${catalog.learningRootPath}`,
      "",
      "HARD RULES:",
      `- Every teaching file belongs inside ONE project folder: ${catalog.learningRootPath}/<topic-slug>/`,
      "- Never write MISSION.md, NOTES.md, GLOSSARY.md, RESOURCES.md, lessons/, learning-records/, or reference/ at the default chat folder root.",
      `- Never write teaching files directly inside ${catalog.learningRootPath} without a <topic-slug> subfolder.`,
      "- Each subject gets its own <topic-slug> folder so projects never overwrite each other.",
    ];

    if (suggestedProjectPath) {
      lines.push(
        "",
        `Active learning project folder for this turn (use this path for every file you create):`,
        suggestedProjectPath,
      );
    } else {
      lines.push(
        "",
        "No project slug yet. Interview the user, pick <topic-slug>, create the project folder under the learning projects root, then write files only inside that folder.",
      );
    }

    if (threadIsDefaultChatFolder) {
      lines.push(
        "",
        `WARNING: The open thread folder is the default chat folder (${catalog.defaultChatCwd}).`,
        "That folder is NOT a learning project. Do not create teaching files here.",
      );
    } else if (threadWorkspaceRoot) {
      lines.push("", `Current thread workspace: ${threadWorkspaceRoot}`);
      lines.push(
        threadIsGitRepo
          ? "Current thread workspace is a git repository — do not write teaching files here."
          : "Do not write teaching files to the thread workspace unless the user explicitly chose it as the project folder.",
      );
    }

    if (misplacedArtifacts.length > 0) {
      lines.push(
        "",
        "Misplaced teaching files detected at the default chat folder root (move them into a project folder before continuing):",
        ...misplacedArtifacts.map((entry) => `- ${entry}`),
      );
    }

    if (catalog.projects.length > 0) {
      lines.push("", "Existing learning projects:");
      for (const project of catalog.projects) {
        const details = [
          project.title ? `title: ${project.title}` : null,
          project.updatedAt ? `updated: ${project.updatedAt}` : null,
        ]
          .filter((value): value is string => value !== null)
          .join(", ");
        lines.push(
          details.length > 0
            ? `- ${project.slug} (${project.absolutePath}) — ${details}`
            : `- ${project.slug} (${project.absolutePath})`,
        );
      }
    } else {
      lines.push("", "Existing learning projects: none yet.");
    }

    return lines.join("\n");
  },
);
