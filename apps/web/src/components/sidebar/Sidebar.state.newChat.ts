import { useCallback } from "react";
import { BUILT_IN_CHATS_PROJECT_ID } from "@bigbud/contracts";
import { resolveNewChatOptions, type useHandleNewThread } from "../../hooks/useHandleNewThread";
import { resolveNewThreadShortcutTarget } from "../../hooks/useHandleNewThread.shortcuts";
import { useUiStateStore } from "../../stores/ui";

type NewChatContext = Pick<
  ReturnType<typeof useHandleNewThread>,
  "activeThread" | "activeDraftThread" | "chatsProjectId" | "handleNewThread"
>;

/** Keep sidebar click targets aligned with their respective keyboard commands. */
export function useSidebarNewChatActions({
  activeThread,
  activeDraftThread,
  chatsProjectId,
  handleNewThread,
}: NewChatContext) {
  const selectedProjectId = useUiStateStore((state) => state.selectedProjectId);

  const handleNewChat = useCallback(() => {
    const target = resolveNewThreadShortcutTarget({
      command: "chat.new",
      activeThread,
      activeDraftThread,
      selectedProjectId,
    });
    return handleNewThread(target.projectId, target.options);
  }, [activeDraftThread, activeThread, handleNewThread, selectedProjectId]);

  const handleNewChats = useCallback(
    () => handleNewThread(chatsProjectId ?? BUILT_IN_CHATS_PROJECT_ID, resolveNewChatOptions()),
    [chatsProjectId, handleNewThread],
  );

  return { handleNewChat, handleNewChats };
}
