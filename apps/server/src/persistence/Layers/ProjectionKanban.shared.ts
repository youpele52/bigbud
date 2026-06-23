import { KanbanCardId, type KanbanStatus, ProjectId } from "@bigbud/contracts";

import { PersistenceSqlError } from "../Errors.ts";

export const KANBAN_DIR_SEGMENT = "kanban";
export const KANBAN_STATUSES: ReadonlyArray<KanbanStatus> = ["backlog", "todo", "ongoing", "done"];

export const resolveMetadataPath = (absolutePath: string) => absolutePath.replace(/\.md$/, ".json");

export const KanbanCardMetadata = {
  parse(text: string): {
    readonly title: string;
    readonly status: KanbanStatus;
    readonly position: number;
    readonly createdAt: string;
    readonly updatedAt: string;
  } | null {
    try {
      const parsed = JSON.parse(text) as Partial<{
        title: string;
        status: KanbanStatus;
        position: number;
        createdAt: string;
        updatedAt: string;
      }>;
      if (
        typeof parsed.title !== "string" ||
        parsed.title.trim().length === 0 ||
        !KANBAN_STATUSES.includes(parsed.status as KanbanStatus) ||
        typeof parsed.position !== "number" ||
        !Number.isFinite(parsed.position) ||
        typeof parsed.createdAt !== "string" ||
        typeof parsed.updatedAt !== "string"
      ) {
        return null;
      }
      return {
        title: parsed.title,
        status: parsed.status as KanbanStatus,
        position: parsed.position,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
      };
    } catch {
      return null;
    }
  },
  stringify(input: {
    readonly title: string;
    readonly status: KanbanStatus;
    readonly position: number;
    readonly createdAt: string;
    readonly updatedAt: string;
  }) {
    return JSON.stringify(input, null, 2);
  },
};

export function fileSystemError(
  operation: string,
  detail: string,
  cause?: unknown,
): PersistenceSqlError {
  return new PersistenceSqlError({ operation, detail, cause });
}

export type StoredKanbanCard = {
  readonly cardId: KanbanCardId;
  readonly projectId: ProjectId | null;
  readonly title: string;
  readonly status: KanbanStatus;
  readonly absolutePath: string;
  readonly content: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly position: number;
};
