import type { AppState } from "./main.store";

export function recordProjectEventSequence(state: AppState, projectId: string, sequence: number) {
  return {
    ...state.latestProjectEventSequenceById,
    [projectId]: Math.max(state.latestProjectEventSequenceById?.[projectId] ?? 0, sequence),
  };
}

export function recordProjectDeletionSequence(
  state: AppState,
  projectId: string,
  sequence: number,
) {
  return {
    ...state.deletedProjectSequenceById,
    [projectId]: Math.max(state.deletedProjectSequenceById?.[projectId] ?? 0, sequence),
  };
}

export function clearProjectDeletionSequence(state: AppState, projectId: string, sequence: number) {
  const deletionSequence = state.deletedProjectSequenceById?.[projectId];
  if (deletionSequence === undefined || deletionSequence > sequence)
    return state.deletedProjectSequenceById ?? {};
  const deletedProjectSequenceById = { ...state.deletedProjectSequenceById };
  delete deletedProjectSequenceById[projectId];
  return deletedProjectSequenceById;
}
