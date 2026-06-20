import * as Rpc from "effect/unstable/rpc/Rpc";

import { WS_METHODS } from "../constants/websocket.constant";
import {
  Note,
  NotesCreateError,
  NotesCreateInput,
  NotesDeleteError,
  NotesDeleteInput,
  NotesDeleteResult,
  NotesGetError,
  NotesGetInput,
  NotesListError,
  NotesListInput,
  NotesListResult,
  NotesUpdateError,
  NotesUpdateInput,
} from "./notes";
import { TeachListProjectsError, TeachListProjectsInput, TeachListProjectsResult } from "./teach";
import {
  ProjectDirectoryWatchError,
  ProjectDirectoryWatchEvent,
  ProjectDirectoryWatchInput,
  ProjectListDirectoryError,
  ProjectListDirectoryInput,
  ProjectListDirectoryResult,
  ProjectReadFilePreviewError,
  ProjectReadFilePreviewInput,
  ProjectReadFilePreviewResult,
  ProjectSearchFileContentsError,
  ProjectSearchFileContentsInput,
  ProjectSearchFileContentsResult,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "../workspace/project";

export const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: ProjectSearchEntriesError,
});

export const WsProjectsSearchFileContentsRpc = Rpc.make(WS_METHODS.projectsSearchFileContents, {
  payload: ProjectSearchFileContentsInput,
  success: ProjectSearchFileContentsResult,
  error: ProjectSearchFileContentsError,
});

export const WsProjectsListDirectoryRpc = Rpc.make(WS_METHODS.projectsListDirectory, {
  payload: ProjectListDirectoryInput,
  success: ProjectListDirectoryResult,
  error: ProjectListDirectoryError,
});

export const WsSubscribeProjectDirectoryChangesRpc = Rpc.make(
  WS_METHODS.subscribeProjectDirectoryChanges,
  {
    payload: ProjectDirectoryWatchInput,
    success: ProjectDirectoryWatchEvent,
    error: ProjectDirectoryWatchError,
    stream: true,
  },
);

export const WsProjectsReadFilePreviewRpc = Rpc.make(WS_METHODS.projectsReadFilePreview, {
  payload: ProjectReadFilePreviewInput,
  success: ProjectReadFilePreviewResult,
  error: ProjectReadFilePreviewError,
});

export const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: ProjectWriteFileError,
});

export const WsNotesListRpc = Rpc.make(WS_METHODS.notesList, {
  payload: NotesListInput,
  success: NotesListResult,
  error: NotesListError,
});

export const WsNotesGetRpc = Rpc.make(WS_METHODS.notesGet, {
  payload: NotesGetInput,
  success: Note,
  error: NotesGetError,
});

export const WsNotesCreateRpc = Rpc.make(WS_METHODS.notesCreate, {
  payload: NotesCreateInput,
  success: Note,
  error: NotesCreateError,
});

export const WsNotesUpdateRpc = Rpc.make(WS_METHODS.notesUpdate, {
  payload: NotesUpdateInput,
  success: Note,
  error: NotesUpdateError,
});

export const WsNotesDeleteRpc = Rpc.make(WS_METHODS.notesDelete, {
  payload: NotesDeleteInput,
  success: NotesDeleteResult,
  error: NotesDeleteError,
});

export const WsTeachListProjectsRpc = Rpc.make(WS_METHODS.teachListProjects, {
  payload: TeachListProjectsInput,
  success: TeachListProjectsResult,
  error: TeachListProjectsError,
});
