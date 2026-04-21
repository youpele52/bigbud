import { ProjectId } from "../core/baseSchemas";

export const BUILT_IN_CHATS_PROJECT_ID = ProjectId.makeUnsafe("__chats__");
export const BUILT_IN_CHATS_PROJECT_TITLE = "Chats";

export function isBuiltInChatsProject(projectId: ProjectId): boolean {
  return projectId === BUILT_IN_CHATS_PROJECT_ID;
}
