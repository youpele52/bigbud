import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { createContext, useContext } from "react";

import type { ComposerChatCitationAttachment } from "../../../stores/composer/types.annotation.store";

export type ChatCitationTarget = Pick<ComposerChatCitationAttachment, "source" | "selection">;

export const ChatCitationContext = createContext<{
  openCitation: (citation: ChatCitationTarget) => void;
  questionFocus: { threadId: ThreadId; requestId: string; token: number } | null;
  onQuestionFocused: (token: number) => void;
} | null>(null);

export function useChatCitationActions() {
  return useContext(ChatCitationContext);
}
