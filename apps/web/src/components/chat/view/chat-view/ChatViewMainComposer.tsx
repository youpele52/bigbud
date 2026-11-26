import { type MessageId } from "@bigbud/contracts";
import { isReadOnlyProviderThread } from "@bigbud/shared/providerLifecycle";

import { useThreadRemoteTarget } from "../../../../hooks/useThreadRemoteTarget";
import { useRemoteAccessStore } from "../../../../stores/remoteAccess/remoteAccess.store";
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
  const activeThread = props.base.activeThread;
  const remoteTarget = useThreadRemoteTarget(props.base.threadId, activeThread?.projectId);
  // A workspace the user disconnected keeps its threads read-only until it reconnects (Q2).
  const remoteDisconnected = useRemoteAccessStore((state) =>
    remoteTarget
      ? state.disconnectedExecutionTargetIds[remoteTarget.executionTargetId] === true
      : false,
  );
  if (!activeThread) {
    return null;
  }
  if (props.base.isServerThread && (isReadOnlyProviderThread(activeThread) || remoteDisconnected)) {
    return null;
  }

  return (
    <>
      <div
        className="px-3 pt-1.5 pb-1 sm:px-5 sm:pt-2"
        data-chat-focus-scope="true"
        data-default-chat-focus-scope="true"
      >
        <ChatViewComposer
          {...props}
          onOpenSideChat={() => {
            void openSideChat(activeThread);
          }}
        />
      </div>
      <SideChatHost
        mainThreadId={activeThread.id}
        onFocusMainComposer={props.runtime.scheduleComposerFocus}
      />
    </>
  );
}
