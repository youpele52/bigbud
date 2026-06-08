import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { NoteId, ProjectId } from "@bigbud/contracts";
import { ServerConfig } from "../../startup/config.ts";
import {
  ProjectionNoteRepository,
  type ProjectionNoteRepositoryShape,
} from "../Services/ProjectionNotes.ts";
import { PersistenceSqlError } from "../Errors.ts";

const NOTES_DIR_SEGMENT = "notes";

function sanitizeFilename(title: string): string {
  return title
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\.{2,}/g, "_")
    .trim();
}

function deriveNoteTitle(content: string): string {
  const firstLine =
    content
      .trim()
      .split("\n")
      .find((line) => line.trim().length > 0) ?? "Untitled note";

  return (
    firstLine
      .replace(/^#+\s*/, "")
      .trim()
      .slice(0, 200) || "Untitled note"
  );
}

function resolveMtime(stat: { mtime: Date | Option.Option<Date> }): Date {
  return Option.isOption(stat.mtime) ? Option.getOrElse(stat.mtime, () => new Date()) : stat.mtime;
}

function fileSystemError(operation: string, detail: string, cause?: unknown): PersistenceSqlError {
  return new PersistenceSqlError({ operation, detail, cause });
}

const makeProjectionNoteRepository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;

  const notesBaseDir = path.join(config.stateDir, NOTES_DIR_SEGMENT);

  const list: ProjectionNoteRepositoryShape["list"] = Effect.fn("ProjectionNoteRepository.list")(
    function* (input: {
      readonly projectId: ProjectId | null;
      readonly scope: "project" | "global";
    }) {
      const targetDir = input.projectId
        ? path.join(notesBaseDir, input.projectId)
        : path.join(notesBaseDir, "global");

      const entries = yield* fs
        .readDirectory(targetDir)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));

      const notes: Array<{
        noteId: NoteId;
        projectId: ProjectId | null;
        title: string;
        absolutePath: string;
        content: string;
        createdAt: string;
        updatedAt: string;
      }> = [];

      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const absolutePath = path.join(targetDir, entry);
        const noteRelPath = path.relative(config.stateDir, absolutePath);
        const stat = yield* fs
          .stat(absolutePath)
          .pipe(Effect.orElseSucceed(() => ({ mtime: new Date() }) as { mtime: Date }));
        const content = yield* fs.readFileString(absolutePath).pipe(Effect.orElseSucceed(() => ""));
        const mtime = resolveMtime(stat);
        notes.push({
          noteId: noteRelPath as NoteId,
          projectId: input.projectId,
          title: entry.slice(0, -3),
          absolutePath,
          content,
          createdAt: mtime.toISOString(),
          updatedAt: mtime.toISOString(),
        });
      }

      if (input.scope === "global" && input.projectId) {
        const globalDir = path.join(notesBaseDir, "global");
        const globalEntries = yield* fs
          .readDirectory(globalDir)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));

        for (const entry of globalEntries) {
          if (!entry.endsWith(".md")) continue;
          const absolutePath = path.join(globalDir, entry);
          const noteRelPath = path.relative(config.stateDir, absolutePath);
          const stat = yield* fs
            .stat(absolutePath)
            .pipe(Effect.orElseSucceed(() => ({ mtime: new Date() }) as { mtime: Date }));
          const content = yield* fs
            .readFileString(absolutePath)
            .pipe(Effect.orElseSucceed(() => ""));
          const mtime = resolveMtime(stat);
          notes.push({
            noteId: noteRelPath as NoteId,
            projectId: null,
            title: entry.slice(0, -3),
            absolutePath,
            content,
            createdAt: mtime.toISOString(),
            updatedAt: mtime.toISOString(),
          });
        }
      }

      return notes.toSorted(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    },
  );

  const getById: ProjectionNoteRepositoryShape["getById"] = Effect.fn(
    "ProjectionNoteRepository.getById",
  )(function* (input: { readonly noteId: NoteId }) {
    const absolutePath = path.join(config.stateDir, input.noteId);
    const exists = yield* fs.exists(absolutePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return Option.none();
    }

    const content = yield* fs.readFileString(absolutePath).pipe(Effect.orElseSucceed(() => ""));
    const stat = yield* fs
      .stat(absolutePath)
      .pipe(Effect.orElseSucceed(() => ({ mtime: new Date() }) as { mtime: Date }));
    const basename = input.noteId.split("/").pop() ?? input.noteId;
    const mtime = resolveMtime(stat);

    const projectId = input.noteId.includes("/global/") ? null : null;

    return Option.some({
      noteId: input.noteId,
      projectId,
      title: basename.endsWith(".md") ? basename.slice(0, -3) : basename,
      absolutePath,
      content,
      createdAt: mtime.toISOString(),
      updatedAt: mtime.toISOString(),
    });
  });

  const create: ProjectionNoteRepositoryShape["create"] = Effect.fn(
    "ProjectionNoteRepository.create",
  )(function* (input: {
    readonly projectId: ProjectId | null;
    readonly title: string;
    readonly content: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  }) {
    const title = input.title ?? deriveNoteTitle(input.content);
    const safeTitle = sanitizeFilename(title);
    const targetDir = input.projectId
      ? path.join(notesBaseDir, input.projectId)
      : path.join(notesBaseDir, "global");
    const noteRelPath = path.relative(config.stateDir, path.join(targetDir, `${safeTitle}.md`));
    const absolutePath = path.join(config.stateDir, noteRelPath);

    const exists = yield* fs.exists(absolutePath).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      return yield* Effect.fail(
        fileSystemError("create", `A note named "${safeTitle}.md" already exists.`),
      );
    }

    yield* fs
      .makeDirectory(targetDir, { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          fileSystemError("create.makeDirectory", "Failed to create note directory", cause),
        ),
      );
    yield* fs
      .writeFileString(absolutePath, input.content)
      .pipe(
        Effect.mapError((cause) =>
          fileSystemError("create.writeFile", "Failed to write note file", cause),
        ),
      );

    return {
      noteId: noteRelPath as NoteId,
      projectId: input.projectId,
      title,
      absolutePath,
      content: input.content,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    };
  });

  const update: ProjectionNoteRepositoryShape["update"] = Effect.fn(
    "ProjectionNoteRepository.update",
  )(function* (input: {
    readonly noteId: NoteId;
    readonly title: string;
    readonly content: string;
  }) {
    const absolutePath = path.join(config.stateDir, input.noteId);
    const exists = yield* fs.exists(absolutePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return yield* Effect.fail(fileSystemError("update", "Note not found"));
    }

    const currentBasename = input.noteId.split("/").pop() ?? input.noteId;
    const currentTitle = currentBasename.endsWith(".md")
      ? currentBasename.slice(0, -3)
      : currentBasename;

    let noteId = input.noteId;
    let foundPath = absolutePath;

    if (input.title && input.title !== currentTitle) {
      const safeTitle = sanitizeFilename(input.title);
      const targetDir = path.dirname(absolutePath);
      const newAbsolutePath = path.join(targetDir, `${safeTitle}.md`);
      const newRelPath = path.relative(config.stateDir, newAbsolutePath);

      const exists = yield* fs.exists(newAbsolutePath).pipe(Effect.orElseSucceed(() => false));
      if (exists) {
        return yield* Effect.fail(
          fileSystemError("update", `A note named "${safeTitle}.md" already exists.`),
        );
      }

      yield* fs
        .rename(foundPath, newAbsolutePath)
        .pipe(
          Effect.mapError((cause) =>
            fileSystemError("update.rename", "Failed to rename note", cause),
          ),
        );
      foundPath = newAbsolutePath;
      noteId = newRelPath as NoteId;
    }

    yield* fs
      .writeFileString(foundPath, input.content)
      .pipe(
        Effect.mapError((cause) =>
          fileSystemError("update.writeFile", "Failed to write note", cause),
        ),
      );

    return yield* getById({ noteId }).pipe(
      Effect.flatMap((note) =>
        Option.match(note, {
          onNone: () => Effect.fail(fileSystemError("update", "Failed to load updated note")),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );
  });

  const deleteById: ProjectionNoteRepositoryShape["deleteById"] = Effect.fn(
    "ProjectionNoteRepository.deleteById",
  )(function* (input: { readonly noteId: NoteId }) {
    const absolutePath = path.join(config.stateDir, input.noteId);
    const exists = yield* fs.exists(absolutePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return;
    }

    yield* fs
      .remove(absolutePath)
      .pipe(
        Effect.mapError((cause) => fileSystemError("deleteById", "Failed to delete note", cause)),
      );
  });

  return {
    list,
    getById,
    create,
    update,
    deleteById,
  } satisfies ProjectionNoteRepositoryShape;
});

export const ProjectionNoteRepositoryLive = Layer.effect(
  ProjectionNoteRepository,
  makeProjectionNoteRepository,
);
