import type {
  CompactChatLinkHandoff,
  FloatingAssistantCaller,
} from "@bigbud/contracts/server/ipc.ts";
import { PlusIcon, SquareArrowOutUpRightIcon, XIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { CompactThreadConversation } from "~/components/chat/side-chat/FloatingSideChat";
import { ThreadComposerSurface } from "~/components/chat/view/ThreadComposerSurface";
import { BigbudLoader } from "~/components/layout/BigbudLoader";
import { BigbudLogo } from "~/components/sidebar/SidebarProjectItem";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useCompactChatThread } from "~/hooks/useCompactChatThread";

import { CompactChatPicker } from "./CompactChatPicker";
import { MASCOT_ANIMATIONS } from "./mascotAssets";
import { useMascotAnimation } from "./useMascotAnimation";

const COMPACT_CHAT_TITLE_MAX_LENGTH = 40;

function formatCompactChatTitle(title: string | null) {
  if (!title) return "New chat";
  if (title.length <= COMPACT_CHAT_TITLE_MAX_LENGTH) return title;
  return `${title.slice(0, COMPACT_CHAT_TITLE_MAX_LENGTH - 3)}...`;
}

function CompactChatHeaderAction(props: {
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  const button = (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.icon}
    </Button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>{button}</TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export function MascotShell() {
  const bridge = window.desktopBridge;
  const dragState = useRef<{ moved: boolean; startX: number; startY: number } | null>(null);
  const didDrag = useRef(false);
  const [caller, setCaller] = useState<FloatingAssistantCaller>("matte");
  const [isHovered, setIsHovered] = useState(false);
  const { animation, animationKey } = useMascotAnimation(isHovered);

  useEffect(() => {
    if (!bridge?.getFloatingAssistantCaller) return;
    void bridge.getFloatingAssistantCaller().then(setCaller);
    return bridge.onFloatingAssistantCallerChange?.(setCaller);
  }, [bridge]);

  const finish = caller === "chrome" ? "chrome" : "matte";

  return (
    <main
      data-floating-assistant-mascot=""
      data-mascot-animation={animation}
      data-mascot-finish={finish}
      className="flex h-screen w-screen items-center justify-center bg-transparent"
    >
      <button
        type="button"
        aria-label="Open floating assistant chat"
        className={
          caller === "logo"
            ? "flex size-28 cursor-pointer items-center justify-center rounded-[36px] border border-white/15 bg-gradient-to-br from-neutral-700 via-neutral-900 to-neutral-950 p-0 text-white shadow-[0_8px_16px_rgb(0_0_0_/_0.28),inset_0_1px_0_rgb(255_255_255_/_0.16)] transition-transform hover:scale-[1.03] active:scale-95"
            : "flex size-36 cursor-grab touch-none select-none items-center justify-center bg-transparent p-0 text-foreground transition-opacity hover:opacity-80 active:cursor-grabbing"
        }
        draggable={false}
        onDragStart={(event) => event.preventDefault()}
        onPointerEnter={() => setIsHovered(true)}
        onPointerLeave={() => setIsHovered(false)}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
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
          if (dragState.current?.moved) didDrag.current = true;
          dragState.current = null;
        }}
        onLostPointerCapture={() => {
          if (dragState.current?.moved) didDrag.current = true;
          dragState.current = null;
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
        {caller === "logo" ? (
          <BigbudLogo className="h-14" />
        ) : (
          <img
            key={`${finish}:${animationKey}`}
            src={MASCOT_ANIMATIONS[finish][animation]}
            alt=""
            draggable={false}
            className="size-full object-contain drop-shadow-[0_5px_4px_rgb(0_0_0_/_0.22)]"
          />
        )}
      </button>
    </main>
  );
}

export function CompactChatShell({
  compactChat,
}: {
  compactChat: ReturnType<typeof useCompactChatThread>;
}) {
  const bridge = window.desktopBridge;
  const {
    isMaterialized,
    newChat,
    preparing,
    projectLoadError,
    retryProjectLoad,
    retryThreadSync,
    selectionUnavailable,
    synchronizeMaterializedThread,
    threadSyncError,
    threadId,
    threadTitle,
    workspaceRoot,
  } = compactChat;
  const canSendCompactLinkHandoff = typeof bridge?.sendMenuAction === "function";
  const onMarkdownAnchorClick = useCallback(
    ({ href }: { href: string }) => {
      if (typeof bridge?.sendMenuAction !== "function") return;
      const action: CompactChatLinkHandoff = {
        type: "compact-chat-link",
        threadId,
        href,
        workspaceRoot: workspaceRoot ?? null,
      };
      void bridge?.openMainWindow?.();
      bridge.sendMenuAction(action);
    },
    [bridge, threadId, workspaceRoot],
  );

  if (preparing) {
    return <BigbudLoader />;
  }

  return (
    <main className="flex h-screen min-h-0 flex-col bg-background text-foreground">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <BigbudLogo className="h-4 text-primary" />
          <span
            className="min-w-0 truncate text-sm text-foreground/80"
            title={threadTitle ?? "New chat"}
          >
            {formatCompactChatTitle(threadTitle)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <CompactChatHeaderAction
            label="Open bigbud"
            disabled={!isMaterialized}
            icon={<SquareArrowOutUpRightIcon className="size-3.5" />}
            onClick={() => void bridge?.openMainWindow?.(threadId)}
          />
          <CompactChatHeaderAction
            label="New chat"
            icon={<PlusIcon className="size-3.5" />}
            onClick={() => void newChat()}
          />
          <CompactChatHeaderAction
            label="Hide chat"
            icon={<XIcon className="size-3.5" />}
            onClick={() => void bridge?.hideCompactChat?.()}
          />
        </div>
      </header>
      {selectionUnavailable ? (
        <p className="border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
          Your selected floating chat model is unavailable. Choose another model before sending.
        </p>
      ) : null}
      {projectLoadError ? (
        <div className="flex items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span>Floating chat could not load: {projectLoadError}</span>
          <Button size="xs" variant="outline" onClick={retryProjectLoad}>
            Retry
          </Button>
        </div>
      ) : null}
      {threadSyncError ? (
        <div className="flex items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span>Floating chat could not synchronize: {threadSyncError}</span>
          <Button size="xs" variant="outline" onClick={retryThreadSync}>
            Retry
          </Button>
        </div>
      ) : null}
      {projectLoadError ? null : (
        <ThreadComposerSurface
          threadId={threadId}
          onThreadMaterialized={synchronizeMaterializedThread}
        >
          {(context) => (
            <CompactThreadConversation
              {...context}
              composerClassName="max-w-[calc(52rem*2/3)]"
              projectPicker={<CompactChatPicker compactChat={compactChat} />}
              workspaceRoot={workspaceRoot}
              onMarkdownAnchorClick={canSendCompactLinkHandoff ? onMarkdownAnchorClick : undefined}
            />
          )}
        </ThreadComposerSurface>
      )}
    </main>
  );
}
