import { Effect, FileSystem, Layer, Option, Path, Semaphore } from "effect";
import { utimes } from "node:fs/promises";
import { KanbanCardId, type KanbanStatus, ProjectId } from "@bigbud/contracts";

import { ServerConfig } from "../../startup/config.ts";
import {
  KanbanCardMetadata,
  KANBAN_DIR_SEGMENT,
  KANBAN_STATUSES,
  fileSystemError,
  resolveMetadataPath,
  type StoredKanbanCard,
} from "./ProjectionKanban.shared.ts";
import { resolveFileMtime } from "./ProjectionFileMtime.ts";
import { nextKanbanColumnPosition } from "./ProjectionKanban.order.ts";
import { makePlaceCard } from "./ProjectionKanban.placement.ts";
import {
  ProjectionKanbanRepository,
  type ListProjectionKanbanCardsInput,
  type MoveProjectionKanbanCardInput,
  type ProjectionKanbanRepositoryShape,
  type ReorderProjectionKanbanCardInput,
  type UpdateProjectionKanbanCardInput,
} from "../Services/ProjectionKanban.ts";

const resolveLatestUpdatedAt = (input: {
  readonly metadataUpdatedAt: string;
  readonly markdownMtime: Date;
}): string => {
  const metadataUpdatedAtTime = Date.parse(input.metadataUpdatedAt);
  const latestTime = Math.max(
    Number.isNaN(metadataUpdatedAtTime) ? 0 : metadataUpdatedAtTime,
    resolveFileMtime(input.markdownMtime).getTime(),
  );
  return new Date(latestTime).toISOString();
};

const makeProjectionKanbanRepository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;

  const kanbanBaseDir = path.join(config.stateDir, KANBAN_DIR_SEGMENT);
  const mutationSemaphore = yield* Semaphore.make(1);
  const serializeMutation = mutationSemaphore.withPermits(1);

  const resolveTargetDir = (projectId: ProjectId | null) =>
    projectId ? path.join(kanbanBaseDir, projectId) : path.join(kanbanBaseDir, "global");

  const projectIdFromCardId = (cardId: KanbanCardId): ProjectId | null => {
    const segments = cardId.split("/");
    return segments[1] === "global" ? null : ((segments[1] ?? null) as ProjectId | null);
  };

  const tryReadCard = Effect.fn("ProjectionKanbanRepository.tryReadCard")(function* (
    absolutePath: string,
  ) {
    const metadataPath = resolveMetadataPath(absolutePath);
    const mdExists = yield* fs.exists(absolutePath).pipe(Effect.orElseSucceed(() => false));
    const metadataExists = yield* fs.exists(metadataPath).pipe(Effect.orElseSucceed(() => false));
    if (!mdExists || !metadataExists) {
      return Option.none<StoredKanbanCard>();
    }

    const content = yield* fs.readFileString(absolutePath).pipe(Effect.option);
    const metadataText = yield* fs.readFileString(metadataPath).pipe(Effect.option);
    if (Option.isNone(content) || Option.isNone(metadataText)) {
      return Option.none<StoredKanbanCard>();
    }

    const metadata = KanbanCardMetadata.parse(metadataText.value);
    if (metadata === null) {
      return Option.none<StoredKanbanCard>();
    }

    const markdownStat = yield* fs.stat(absolutePath).pipe(Effect.option);
    if (Option.isNone(markdownStat)) {
      return Option.none<StoredKanbanCard>();
    }

    const cardId = path.relative(config.stateDir, absolutePath) as KanbanCardId;

    return Option.some({
      cardId,
      projectId: projectIdFromCardId(cardId),
      title: metadata.title,
      status: metadata.status,
      absolutePath,
      content: content.value,
      createdAt: metadata.createdAt,
      updatedAt: resolveLatestUpdatedAt({
        metadataUpdatedAt: metadata.updatedAt,
        markdownMtime: resolveFileMtime(markdownStat.value.mtime),
      }),
      position: metadata.position,
    });
  });

  const listStoredCards = Effect.fn("ProjectionKanbanRepository.listStoredCards")(function* (
    input: ListProjectionKanbanCardsInput,
  ) {
    if (input.scope === "project" && input.projectId === null) {
      return [];
    }

    const targetDir = resolveTargetDir(input.scope === "project" ? input.projectId : null);
    const entries = yield* fs
      .readDirectory(targetDir)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));

    const cards: Array<StoredKanbanCard> = [];

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const absolutePath = path.join(targetDir, entry);
      const card = yield* tryReadCard(absolutePath);
      if (Option.isSome(card)) {
        cards.push(card.value);
      }
    }

    return cards.toSorted((a, b) => {
      const statusDelta = KANBAN_STATUSES.indexOf(a.status) - KANBAN_STATUSES.indexOf(b.status);
      return statusDelta !== 0 ? statusDelta : a.position - b.position;
    });
  });

  const list: ProjectionKanbanRepositoryShape["list"] = Effect.fn(
    "ProjectionKanbanRepository.list",
  )(function* (input) {
    const cards = yield* listStoredCards(input);
    return cards.map(({ position: _position, ...card }) => card);
  });

  const getById: ProjectionKanbanRepositoryShape["getById"] = Effect.fn(
    "ProjectionKanbanRepository.getById",
  )(function* (input) {
    const absolutePath = path.join(config.stateDir, input.cardId);
    const exists = yield* fs.exists(absolutePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return Option.none();
    }

    const card = yield* tryReadCard(absolutePath);
    return Option.map(card, ({ position: _position, ...value }) => value);
  });

  const nextPositionForStatus = Effect.fn("ProjectionKanbanRepository.nextPositionForStatus")(
    function* (projectId: ProjectId | null, status: KanbanStatus) {
      const cards = yield* listStoredCards({
        projectId,
        scope: projectId ? "project" : "global",
      });
      return nextKanbanColumnPosition(cards, status);
    },
  );

  const placeCard = makePlaceCard({
    fs,
    path,
    stateDir: config.stateDir,
    tryReadCard,
    listStoredCards,
  });

  const create: ProjectionKanbanRepositoryShape["create"] = Effect.fn(
    "ProjectionKanbanRepository.create",
  )(function* (input) {
    const targetDir = resolveTargetDir(input.projectId);
    const fileStem = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const absolutePath = path.join(targetDir, `${fileStem}.md`);
    const metadataPath = resolveMetadataPath(absolutePath);
    const position = yield* nextPositionForStatus(input.projectId, input.status);

    yield* fs
      .makeDirectory(targetDir, { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          fileSystemError("create.makeDirectory", "Failed to create kanban directory", cause),
        ),
      );
    yield* fs
      .writeFileString(absolutePath, input.content)
      .pipe(
        Effect.mapError((cause) =>
          fileSystemError("create.writeFile", "Failed to write kanban markdown file", cause),
        ),
      );
    yield* fs
      .writeFileString(
        metadataPath,
        KanbanCardMetadata.stringify({
          title: input.title,
          status: input.status,
          position,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          fileSystemError("create.writeMetadata", "Failed to write kanban metadata file", cause),
        ),
      );
    yield* Effect.tryPromise({
      try: () => utimes(absolutePath, new Date(input.updatedAt), new Date(input.updatedAt)),
      catch: (cause) => fileSystemError("create.utimes", "Failed to persist card timestamp", cause),
    });

    const cardId = path.relative(config.stateDir, absolutePath) as KanbanCardId;
    return {
      cardId,
      projectId: input.projectId,
      title: input.title,
      status: input.status,
      absolutePath,
      content: input.content,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    };
  });

  const updateUnlocked = Effect.fn("ProjectionKanbanRepository.update")(function* (
    input: UpdateProjectionKanbanCardInput,
  ) {
    const absolutePath = path.join(config.stateDir, input.cardId);
    const card = yield* tryReadCard(absolutePath);
    if (Option.isNone(card)) {
      return yield* fileSystemError("update", "Kanban card not found");
    }
    if (input.expectedUpdatedAt && input.expectedUpdatedAt !== card.value.updatedAt) {
      return yield* fileSystemError(
        "update",
        "Item changed since it was read. Reload and try again.",
      );
    }

    yield* fs
      .writeFileString(absolutePath, input.content)
      .pipe(
        Effect.mapError((cause) =>
          fileSystemError("update.writeFile", "Failed to write kanban card", cause),
        ),
      );
    yield* fs
      .writeFileString(
        resolveMetadataPath(absolutePath),
        KanbanCardMetadata.stringify({
          title: input.title,
          status: card.value.status,
          position: card.value.position,
          createdAt: card.value.createdAt,
          updatedAt: input.updatedAt,
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          fileSystemError("update.writeMetadata", "Failed to write kanban metadata", cause),
        ),
      );
    yield* Effect.tryPromise({
      try: () => utimes(absolutePath, new Date(input.updatedAt), new Date(input.updatedAt)),
      catch: (cause) => fileSystemError("update.utimes", "Failed to persist card timestamp", cause),
    });

    return {
      cardId: card.value.cardId,
      projectId: card.value.projectId,
      title: input.title,
      status: card.value.status,
      absolutePath: card.value.absolutePath,
      content: input.content,
      createdAt: card.value.createdAt,
      updatedAt: input.updatedAt,
    };
  });
  const update: ProjectionKanbanRepositoryShape["update"] = (input) =>
    serializeMutation(updateUnlocked(input));

  const moveUnlocked = Effect.fn("ProjectionKanbanRepository.move")(function* (
    input: MoveProjectionKanbanCardInput,
  ) {
    const absolutePath = path.join(config.stateDir, input.cardId);
    const card = yield* tryReadCard(absolutePath);
    if (Option.isNone(card)) {
      return yield* fileSystemError("move", "Kanban card not found");
    }

    const scopeInput: ListProjectionKanbanCardsInput = {
      projectId: card.value.projectId,
      scope: card.value.projectId ? "project" : "global",
    };
    const storedCards = yield* listStoredCards(scopeInput);
    const targetColumnLength = storedCards.filter(
      (stored) => stored.status === input.status && stored.cardId !== input.cardId,
    ).length;
    const targetIndex = input.targetIndex ?? targetColumnLength;

    return yield* placeCard({
      cardId: input.cardId,
      status: input.status,
      targetIndex,
      updatedAt: input.updatedAt,
      expectedUpdatedAt: input.expectedUpdatedAt,
    });
  });
  const move: ProjectionKanbanRepositoryShape["move"] = (input) =>
    serializeMutation(moveUnlocked(input));

  const reorderWithinStatusUnlocked = Effect.fn("ProjectionKanbanRepository.reorderWithinStatus")(
    function* (input: ReorderProjectionKanbanCardInput) {
      const absolutePath = path.join(config.stateDir, input.cardId);
      const card = yield* tryReadCard(absolutePath);
      if (Option.isNone(card)) {
        return yield* fileSystemError("reorderWithinStatus", "Kanban card not found");
      }

      if (card.value.status !== input.status) {
        return yield* fileSystemError(
          "reorderWithinStatus",
          "Kanban card is not in the requested status",
        );
      }

      return yield* placeCard({
        cardId: input.cardId,
        status: input.status,
        targetIndex: input.targetIndex,
        updatedAt: input.updatedAt,
        expectedUpdatedAt: input.expectedUpdatedAt,
      });
    },
  );
  const reorderWithinStatus: ProjectionKanbanRepositoryShape["reorderWithinStatus"] = (input) =>
    serializeMutation(reorderWithinStatusUnlocked(input));

  const deleteById: ProjectionKanbanRepositoryShape["deleteById"] = Effect.fn(
    "ProjectionKanbanRepository.deleteById",
  )(function* (input) {
    const absolutePath = path.join(config.stateDir, input.cardId);
    const metadataPath = resolveMetadataPath(absolutePath);

    if (yield* fs.exists(absolutePath).pipe(Effect.orElseSucceed(() => false))) {
      yield* fs
        .remove(absolutePath)
        .pipe(
          Effect.mapError((cause) =>
            fileSystemError("deleteById.removeFile", "Failed to delete kanban card", cause),
          ),
        );
    }
    if (yield* fs.exists(metadataPath).pipe(Effect.orElseSucceed(() => false))) {
      yield* fs
        .remove(metadataPath)
        .pipe(
          Effect.mapError((cause) =>
            fileSystemError("deleteById.removeMetadata", "Failed to delete kanban metadata", cause),
          ),
        );
    }
  });

  return {
    list,
    getById,
    create,
    update,
    move,
    reorderWithinStatus,
    deleteById,
  } satisfies ProjectionKanbanRepositoryShape;
});

export const ProjectionKanbanRepositoryLive = Layer.effect(
  ProjectionKanbanRepository,
  makeProjectionKanbanRepository,
);
