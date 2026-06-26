import { Effect, FileSystem, Option, Path } from "effect";
import { KanbanCardId, type KanbanStatus } from "@bigbud/contracts";

import type { ListProjectionKanbanCardsInput } from "../Services/ProjectionKanban.ts";
import {
  planKanbanColumnPlacement,
  type KanbanCardPositionUpdate,
} from "./ProjectionKanban.order.ts";
import {
  KanbanCardMetadata,
  fileSystemError,
  resolveMetadataPath,
  type StoredKanbanCard,
} from "./ProjectionKanban.shared.ts";

interface PlacementDeps {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly stateDir: string;
  readonly tryReadCard: (
    absolutePath: string,
  ) => Effect.Effect<Option.Option<StoredKanbanCard>, never, never>;
  readonly listStoredCards: (
    input: ListProjectionKanbanCardsInput,
  ) => Effect.Effect<ReadonlyArray<StoredKanbanCard>, never, never>;
}

export const makePlaceCard = (deps: PlacementDeps) =>
  Effect.fn("ProjectionKanbanRepository.placeCard")(function* (input: {
    readonly cardId: KanbanCardId;
    readonly status: KanbanStatus;
    readonly targetIndex: number;
    readonly updatedAt: string;
  }) {
    const absolutePath = deps.path.join(deps.stateDir, input.cardId);
    const card = yield* deps.tryReadCard(absolutePath);
    if (Option.isNone(card)) {
      return yield* fileSystemError("placeCard", "Kanban card not found");
    }

    const scopeInput: ListProjectionKanbanCardsInput = {
      projectId: card.value.projectId,
      scope: card.value.projectId ? "project" : "global",
    };
    const storedCards = yield* deps.listStoredCards(scopeInput);
    const updates = planKanbanColumnPlacement(
      storedCards,
      input.cardId,
      input.status,
      input.targetIndex,
    );
    if (!updates) {
      return yield* fileSystemError("placeCard", "Kanban card not found");
    }

    const updatesById = new Map(updates.map((update) => [update.cardId, update]));

    for (const stored of storedCards) {
      const update = updatesById.get(stored.cardId);
      if (!update) {
        continue;
      }

      yield* deps.fs
        .writeFileString(
          resolveMetadataPath(stored.absolutePath),
          KanbanCardMetadata.stringify({
            title: stored.title,
            status: update.status,
            position: update.position,
            createdAt: stored.createdAt,
            updatedAt: stored.cardId === input.cardId ? input.updatedAt : stored.updatedAt,
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            fileSystemError(
              "applyPositionUpdates.writeMetadata",
              "Failed to write kanban metadata",
              cause,
            ),
          ),
        );
    }

    const moved = storedCards.find((stored) => stored.cardId === input.cardId);
    const movedUpdate = updatesById.get(input.cardId);
    if (!moved || !movedUpdate) {
      return yield* fileSystemError("applyPositionUpdates", "Kanban card not found");
    }

    return {
      cardId: moved.cardId,
      projectId: moved.projectId,
      title: moved.title,
      status: movedUpdate.status,
      absolutePath: moved.absolutePath,
      content: moved.content,
      createdAt: moved.createdAt,
      updatedAt: input.updatedAt,
    };
  });

export type { KanbanCardPositionUpdate };
