import { ExternalLinkIcon, PlusIcon, XIcon } from "lucide-react";
import { useRef } from "react";

import { CompactThreadConversation } from "~/components/chat/side-chat/FloatingSideChat";
import { ThreadComposerSurface } from "~/components/chat/view/ThreadComposerSurface";
import { BigbudLogo } from "~/components/sidebar/SidebarProjectItem";
import { Button } from "~/components/ui/button";
import { useCompactChatThread } from "~/hooks/useCompactChatThread";

export function MascotShell() {
  const bridge = window.desktopBridge;
  const dragState = useRef<{ moved: boolean; startX: number; startY: number } | null>(null);
  const didDrag = useRef(false);
  return (
    <main className="flex h-screen w-screen items-center justify-center bg-transparent p-1">
      <button
        type="button"
        aria-label="Open floating assistant chat"
        className="flex size-14 cursor-pointer items-center justify-center bg-transparent p-0 text-foreground transition-opacity hover:opacity-80"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          didDrag.current = false;
          dragState.current = { moved: false, startX: event.screenX, startY: event.screenY };
          void bridge?.beginMascotDrag?.({ x: event.screenX, y: event.screenY });
        }}
        onPointerMove={(event) => {
          const state = dragState.current;
          if (!state) return;
          if (
            !state.moved &&
            Math.hypot(event.screenX - state.startX, event.screenY - state.startY) < 4
          ) {
            return;
          }
          state.moved = true;
          didDrag.current = true;
          void bridge?.moveMascot?.({ x: event.screenX, y: event.screenY });
        }}
        onPointerCancel={() => {
          dragState.current = null;
          didDrag.current = false;
        }}
        onClick={(event) => {
          if (didDrag.current) {
            didDrag.current = false;
            dragState.current = null;
            event.preventDefault();
            return;
          }
          dragState.current = null;
          void bridge?.openCompactChat?.();
        }}
      >
        <BigbudLogo className="h-7" />
      </button>
    </main>
  );
}

export function CompactChatShell() {
  const bridge = window.desktopBridge;
  const { isMaterialized, newChat, selectionUnavailable, threadId } = useCompactChatThread();
  return (
    <main className="flex h-screen min-h-0 flex-col bg-background text-foreground">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <BigbudLogo className="h-4 text-primary" />
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Open bigbud"
            disabled={!isMaterialized}
            onClick={() => void bridge?.openMainWindow?.(threadId)}
          >
            <ExternalLinkIcon className="size-3.5" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="New chat"
            onClick={() => void newChat()}
          >
            <PlusIcon className="size-3.5" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Hide chat"
            onClick={() => void bridge?.hideCompactChat?.()}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </header>
      {selectionUnavailable ? (
        <p className="border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
          Your selected floating chat model is unavailable. Choose another model before sending.
        </p>
      ) : null}
      <ThreadComposerSurface threadId={threadId}>
        {(context) => <CompactThreadConversation {...context} workspaceRoot={undefined} />}
      </ThreadComposerSurface>
    </main>
  );
}
