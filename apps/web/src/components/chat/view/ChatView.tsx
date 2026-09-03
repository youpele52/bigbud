import { ChatViewEmptyState } from "../common/ChatViewEmptyState";
import { useChatViewBaseState } from "./chat-view/chat-view-base-state.hooks";
import { useChatViewComposerDerivedState } from "./chat-view/chat-view-composer-derived.hooks";
import { ChatViewContent } from "./chat-view/ChatViewContent";
import { useChatViewEffects } from "./chat-view/chat-view-effects.hooks";
import { useChatViewInteractions } from "./chat-view/chat-view-interactions.hooks";
import { useChatViewRuntime } from "./chat-view/chat-view-runtime.hooks";
import { useChatViewThreadDerivedState } from "./chat-view/chat-view-thread-derived.hooks";
import { useChatViewTimelineState } from "./chat-view/chat-view-timeline.hooks";
import { usePlanCardToggleShortcut } from "./chat-view/ChatViewPlanCardShortcut";
import { useTerminalLayout } from "./chat-view/terminalLayout.hooks";
import type { ChatViewProps } from "./chat-view/shared";

export default function ChatView({ threadId }: ChatViewProps) {
  const base = useChatViewBaseState({ threadId });
  const thread = useChatViewThreadDerivedState(base);
  const composer = useChatViewComposerDerivedState(base);
  const timeline = useChatViewTimelineState({ base, thread });
  const runtime = useChatViewRuntime({ base, thread, composer, timeline });
  const terminalLayout = useTerminalLayout({
    activeThreadId: base.threadId,
    terminalOpen: base.terminalState.terminalOpen,
    setTerminalOpen: runtime.terminalActions.setTerminalOpen,
    toggleTerminalVisibility: runtime.terminalActions.toggleTerminalVisibility,
  });
  const interactions = useChatViewInteractions({
    base,
    composer,
    thread,
    timeline,
    runtime,
    toggleTerminalVisibility: terminalLayout.toggleTerminal,
  });

  useChatViewEffects({ base, composer, thread, runtime });
  usePlanCardToggleShortcut({
    enabled: base.isServerThread && base.activeThread !== undefined,
    keybindings: composer.keybindings,
    terminalOpen: base.terminalState.terminalOpen,
    togglePlanCard: runtime.togglePlanCard,
  });

  if (!base.activeThread) {
    return <ChatViewEmptyState />;
  }

  return (
    <ChatViewContent
      base={base}
      thread={thread}
      composer={composer}
      timeline={timeline}
      runtime={runtime}
      interactions={interactions}
      terminalLayout={terminalLayout}
    />
  );
}
