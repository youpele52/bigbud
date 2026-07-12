import { type MessageId } from "@bigbud/contracts";

import { openSideChat } from "../../side-chat/sideChat.actions";
import { SideChatHost } from "../../side-chat/SideChatHost";
import { ChatViewComposer } from "./ChatViewComposer";
import { type ChatViewBaseState } from "./chat-view-base-state.hooks";
import { type ChatViewComposerDerivedState } from "./chat-view-composer-derived.hooks";
import { type ChatViewInteractionsState } from "./chat-view-interactions.hooks";
import { type ChatViewRuntimeState } from "./chat-view-runtime.hooks";
import { type ChatViewThreadDerivedState } from "./chat-view-thread-derived.hooks";

export function ChatViewMainComposer(props: {
  base: ChatViewBaseState;
  composer: ChatViewComposerDerivedState;
  interactions: ChatViewInteractionsState;
  runtime: ChatViewRuntimeState;
  thread: ChatViewThreadDerivedState;
  onOpenOrchestra: () => void;
  onOpenReplySource: (messageId: MessageId) => void;
}) {
  if (!props.base.activeThread) {
    return null;
  }

  return (
    <>
      <div className="px-3 pt-1.5 pb-1 sm:px-5 sm:pt-2">
        <ChatViewComposer
          {...props}
          onOpenSideChat={() => {
            void openSideChat(props.base.activeThread!);
          }}
        />
      </div>
      <SideChatHost
        mainThreadId={props.base.activeThread.id}
        onFocusMainComposer={props.runtime.scheduleComposerFocus}
      />
    </>
  );
}
