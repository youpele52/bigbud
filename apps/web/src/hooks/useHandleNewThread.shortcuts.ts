import {
  BUILT_IN_CHATS_PROJECT_ID,
  isBuiltInChatsProject,
} from "@bigbud/contracts/constants/project.constant";
import type { ProjectId } from "@bigbud/contracts";
import { resolveContextualNewThreadOptions, resolveNewChatOptions } from "./useHandleNewThread";

type ThreadContext = Parameters<typeof resolveContextualNewThreadOptions>[0];

/** Resolve chat commands without falling back to an arbitrary catalog project. */
export function resolveNewThreadShortcutTarget(input: {
  command: "chat.new" | "chat.newLocal";
  activeThread:
    | (NonNullable<ThreadContext["activeThread"]> & { projectId: ProjectId })
    | null
    | undefined;
  activeDraftThread:
    | (NonNullable<ThreadContext["activeDraftThread"]> & { projectId: ProjectId })
    | null;
  selectedProjectId: ProjectId | null;
}) {
  const context = input.activeThread ?? input.activeDraftThread;
  const projectId =
    input.command === "chat.newLocal"
      ? BUILT_IN_CHATS_PROJECT_ID
      : (context?.projectId ?? input.selectedProjectId ?? BUILT_IN_CHATS_PROJECT_ID);
  return {
    projectId,
    options: isBuiltInChatsProject(projectId)
      ? resolveNewChatOptions()
      : resolveContextualNewThreadOptions({
          activeThread: input.activeThread,
          activeDraftThread: input.activeThread ? null : input.activeDraftThread,
        }),
  };
}
