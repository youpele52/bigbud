import { type MessageId, type ThreadId } from "@bigbud/contracts";
import { type ReactNode, useEffect, useRef } from "react";

import { useComposerDraftStore, useComposerThreadDraft } from "~/stores/composer";

import { useChatViewBaseState } from "./chat-view/chat-view-base-state.hooks";
import { useChatViewComposerDerivedState } from "./chat-view/chat-view-composer-derived.hooks";
import { useChatViewEffects } from "./chat-view/chat-view-effects.hooks";
import { useChatViewInteractions } from "./chat-view/chat-view-interactions.hooks";
import { useChatViewRuntime } from "./chat-view/chat-view-runtime.hooks";
import { useChatViewThreadDerivedState } from "./chat-view/chat-view-thread-derived.hooks";
import { useChatViewTimelineState } from "./chat-view/chat-view-timeline.hooks";
import { ChatViewComposer } from "./chat-view/ChatViewComposer";

export interface ThreadComposerSurfaceContext {
  base: ReturnType<typeof useChatViewBaseState>;
  composer: ReturnType<typeof useChatViewComposerDerivedState>;
  interactions: ReturnType<typeof useChatViewInteractions>;
  runtime: ReturnType<typeof useChatViewRuntime>;
  thread: ReturnType<typeof useChatViewThreadDerivedState>;
  timeline: ReturnType<typeof useChatViewTimelineState>;
}

export function ThreadComposerSurface({
  className,
  children,
  onOptimisticUserMessage,
  seedPrompt,
  threadId,
  transformPromptForSend,
}: {
  readonly className?: string;
  readonly onOptimisticUserMessage?: ((messageId: MessageId) => void) | undefined;
  readonly seedPrompt?: string | undefined;
  readonly threadId: ThreadId;
  readonly transformPromptForSend?: ((prompt: string) => string) | undefined;
  readonly children?: ((context: ThreadComposerSurfaceContext) => ReactNode) | undefined;
}) {
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const draft = useComposerThreadDraft(threadId);
  const seededRef = useRef(false);
  const prevThreadIdRef = useRef(threadId);
  if (prevThreadIdRef.current !== threadId) {
    prevThreadIdRef.current = threadId;
    seededRef.current = false;
  }
  const base = useChatViewBaseState({ threadId });
  const thread = useChatViewThreadDerivedState(base);
  const composer = useChatViewComposerDerivedState(base);
  const timeline = useChatViewTimelineState({ base, thread });
  const runtime = useChatViewRuntime({ base, thread, composer, timeline });
  const interactions = useChatViewInteractions({
    base,
    composer,
    thread,
    timeline,
    runtime,
    onOptimisticUserMessage,
    transformPromptForSend,
    enableKeybindings: false,
  });

  useChatViewEffects({ base, composer, embedded: true, thread, runtime });

  useEffect(() => {
    if (seededRef.current || !seedPrompt || draft.prompt.trim().length > 0) {
      return;
    }
    seededRef.current = true;
    setPrompt(threadId, seedPrompt);
  }, [draft.prompt, seedPrompt, setPrompt, threadId]);

  if (!base.activeThread) {
    return null;
  }

  if (children) {
    return children({ base, composer, interactions, runtime, thread, timeline });
  }

  return (
    <ChatViewComposer
      base={base}
      {...(className !== undefined ? { className } : {})}
      composer={composer}
      thread={thread}
      runtime={runtime}
      interactions={interactions}
      onOpenOrchestra={() => undefined}
      onOpenReplySource={() => undefined}
    />
  );
}
