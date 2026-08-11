import { assert, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { describe } from "vitest";

import { resolveFileMtime } from "./ProjectionFileMtime.ts";
import { ProjectionKanbanRepositoryLive } from "./ProjectionKanban.ts";
import { KanbanCardMetadata } from "./ProjectionKanban.shared.ts";
import { ProjectionNoteRepositoryLive } from "./ProjectionNotes.ts";
import { ProjectionKanbanRepository } from "../Services/ProjectionKanban.ts";
import { ProjectionNoteRepository } from "../Services/ProjectionNotes.ts";
import { ServerConfig } from "../../startup/config.ts";

const INVALID_MTIME_MARKER = "invalid-mtime";
const UNIX_EPOCH_ISO = "1970-01-01T00:00:00.000Z";

const timestampRepositoryLayer = it.layer(
  Layer.unwrap(
    Effect.gen(function* () {
      const realFileSystem = yield* FileSystem.FileSystem;
      const invalidMtimeFileSystem = FileSystem.FileSystem.of({
        ...realFileSystem,
        stat: (filePath) =>
          realFileSystem
            .stat(filePath)
            .pipe(
              Effect.map((info) =>
                filePath.includes(INVALID_MTIME_MARKER)
                  ? { ...info, mtime: Option.some(new Date(Number.NaN)) }
                  : info,
              ),
            ),
      });
      const platformLayer = Layer.mergeAll(
        NodePath.layer,
        Layer.succeed(FileSystem.FileSystem, invalidMtimeFileSystem),
      );
      const configLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "bigbud-projection-file-mtime-",
      }).pipe(Layer.provide(platformLayer));

      return Layer.mergeAll(ProjectionKanbanRepositoryLive, ProjectionNoteRepositoryLive).pipe(
        Layer.provideMerge(Layer.mergeAll(platformLayer, configLayer)),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

const writeKanbanFixture = Effect.fn("writeKanbanTimestampFixture")(function* (input: {
  readonly directory: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly stem: string;
  readonly title: string;
  readonly updatedAt: string;
}) {
  yield* input.fileSystem.makeDirectory(input.directory, { recursive: true });
  yield* input.fileSystem.writeFileString(
    input.path.join(input.directory, `${input.stem}.md`),
    `# ${input.title}\n`,
  );
  yield* input.fileSystem.writeFileString(
    input.path.join(input.directory, `${input.stem}.json`),
    KanbanCardMetadata.stringify({
      title: input.title,
      status: "backlog",
      position: 0,
      createdAt: "2026-08-11T18:00:00.000Z",
      updatedAt: input.updatedAt,
    }),
  );
});

describe("resolveFileMtime", () => {
  it("preserves a valid modification time", () => {
    const mtime = new Date("2026-08-11T18:00:00.000Z");

    assert.equal(resolveFileMtime(mtime).toISOString(), mtime.toISOString());
  });

  it("uses the Unix epoch for missing or invalid modification times", () => {
    assert.equal(resolveFileMtime(Option.none()).toISOString(), UNIX_EPOCH_ISO);
    assert.equal(resolveFileMtime(new Date(Number.NaN)).toISOString(), UNIX_EPOCH_ISO);
  });
});

timestampRepositoryLayer("projection repository invalid mtimes", (it) => {
  it.effect("lists other notes when one note has an invalid filesystem mtime", () =>
    Effect.gen(function* () {
      const notes = yield* ProjectionNoteRepository;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const globalNotesDirectory = path.join(config.notesDir, "global");

      yield* fileSystem.makeDirectory(globalNotesDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(globalNotesDirectory, "valid.md"),
        "# Valid note\n",
      );
      yield* fileSystem.writeFileString(
        path.join(globalNotesDirectory, `${INVALID_MTIME_MARKER}.md`),
        "# Invalid mtime note\n",
      );

      const listed = yield* notes.list({ projectId: null, scope: "global" });
      assert.deepStrictEqual(listed.map((note) => note.title).toSorted(), [
        "Invalid mtime note",
        "Valid note",
      ]);
      assert.equal(
        listed.find((note) => note.title === "Invalid mtime note")?.updatedAt,
        UNIX_EPOCH_ISO,
      );
    }),
  );

  it.effect("keeps valid kanban metadata time when the markdown mtime is invalid", () =>
    Effect.gen(function* () {
      const kanban = yield* ProjectionKanbanRepository;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const metadataUpdatedAt = "2026-08-11T19:00:00.000Z";

      yield* writeKanbanFixture({
        directory: path.join(config.kanbanDir, "global"),
        fileSystem,
        path,
        stem: `${INVALID_MTIME_MARKER}-valid-metadata`,
        title: "Valid metadata time",
        updatedAt: metadataUpdatedAt,
      });

      const listed = yield* kanban.list({ projectId: null, scope: "global" });
      assert.equal(
        listed.find((card) => card.title === "Valid metadata time")?.updatedAt,
        metadataUpdatedAt,
      );
    }),
  );

  it.effect("uses the Unix epoch when kanban metadata time and markdown mtime are invalid", () =>
    Effect.gen(function* () {
      const kanban = yield* ProjectionKanbanRepository;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;

      yield* writeKanbanFixture({
        directory: path.join(config.kanbanDir, "global"),
        fileSystem,
        path,
        stem: `${INVALID_MTIME_MARKER}-invalid-metadata`,
        title: "Invalid metadata time",
        updatedAt: "not-a-timestamp",
      });

      const listed = yield* kanban.list({ projectId: null, scope: "global" });
      assert.equal(
        listed.find((card) => card.title === "Invalid metadata time")?.updatedAt,
        UNIX_EPOCH_ISO,
      );
    }),
  );
});
