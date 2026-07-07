import type { KanbanScope, NoteScope, ServerStoragePaths } from "@bigbud/contracts";

function joinStoragePath(baseDir: string, segment: string): string {
  return `${baseDir.replace(/[\\/]+$/, "")}/${segment}`;
}

export function getNotesWatchRoots(
  storage: ServerStoragePaths | undefined,
  projectId: string | null,
  scope: NoteScope,
): string[] {
  if (!storage) {
    return [];
  }

  if (scope === "project") {
    return projectId ? [joinStoragePath(storage.notesDir, projectId)] : [];
  }

  return projectId
    ? [joinStoragePath(storage.notesDir, "global"), joinStoragePath(storage.notesDir, projectId)]
    : [joinStoragePath(storage.notesDir, "global")];
}

export function getKanbanWatchRoots(
  storage: ServerStoragePaths | undefined,
  projectId: string | null,
  scope: KanbanScope,
): string[] {
  if (!storage) {
    return [];
  }

  if (scope === "project") {
    return projectId ? [joinStoragePath(storage.kanbanDir, projectId)] : [];
  }

  return [joinStoragePath(storage.kanbanDir, "global")];
}
