import { Effect, Option, type FileSystem, type Path } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";

import type { ProjectionRepositoryError } from "../Errors.ts";
import type { ListProjectionKanbanCardsInput } from "../Services/ProjectionKanban.ts";
import { KANBAN_STATUSES, type StoredKanbanCard } from "./ProjectionKanban.shared.ts";
import { isActiveProject } from "./ProjectionProjectLifecycle.ts";

export function makeListStoredCards(deps: {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly sql: Option.Option<SqlClient.SqlClient>;
  readonly resolveTargetDir: (projectId: ProjectId | null) => string;
  readonly tryReadCard: (absolutePath: string) => Effect.Effect<Option.Option<StoredKanbanCard>>;
}): (
  input: ListProjectionKanbanCardsInput,
) => Effect.Effect<ReadonlyArray<StoredKanbanCard>, ProjectionRepositoryError> {
  return Effect.fn("ProjectionKanbanRepository.listStoredCards")(function* (
    input: ListProjectionKanbanCardsInput,
  ) {
    if (input.scope === "project") {
      if (input.projectId === null) return [];
      const active = yield* isActiveProject(deps.sql, input.projectId);
      if (!active) return [];
    }
    const targetDir = deps.resolveTargetDir(input.scope === "project" ? input.projectId : null);
    const entries = yield* deps.fs
      .readDirectory(targetDir)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
    const cards: StoredKanbanCard[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const card = yield* deps.tryReadCard(deps.path.join(targetDir, entry));
      if (Option.isSome(card)) cards.push(card.value);
    }
    return cards.toSorted((a, b) => {
      const statusDelta = KANBAN_STATUSES.indexOf(a.status) - KANBAN_STATUSES.indexOf(b.status);
      return statusDelta !== 0 ? statusDelta : a.position - b.position;
    });
  });
}
