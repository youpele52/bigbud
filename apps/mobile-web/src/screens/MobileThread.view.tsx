import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps, Ref } from "react";

import type { MobileRecoveryState } from "../logic/mobileRecovery.types";
import type { MobileConnectionState } from "../logic/mobileConnection.logic";

import { MobileConnectionNotice } from "../components/shell/MobileConnectionNotice";
import { resolveMobileConnectionNotice } from "../components/shell/MobileConnectionNotice.logic";
import { MobileComposer } from "../components/threads/thread/composer/MobileComposer";
import { MobileWorkingIndicator } from "../components/threads/thread/composer/MobileWorkingIndicator";
import { MobileMessages } from "../components/threads/thread/MobileMessages";
import { MobileReaderOutline } from "../components/threads/thread/MobileReaderOutline";
import { MobileWorkLog } from "../components/threads/thread/MobileWorkLog";
import { shouldShowMobileEmptyState } from "./MobileThread.view.logic";

interface MobileThreadViewProps {
  readonly activeWorkStartedAt: string | null;
  readonly composerProps: ComponentProps<typeof MobileComposer>;
  readonly messages: ComponentProps<typeof MobileMessages>["messages"];
  readonly messagesScrollRef: Ref<HTMLDivElement>;
  readonly recoveryState: MobileRecoveryState;
  readonly connection: MobileConnectionState;
  readonly onRetryRecovery: () => void;
  readonly isFollowing: boolean;
  readonly onScrollToLatest: () => void;
  readonly nowIso: string;
  readonly readerOutlineProps: ComponentProps<typeof MobileReaderOutline>;
  readonly showWorkingIndicator: boolean;
  readonly workingVerb: string;
  readonly workLogEntries: ComponentProps<typeof MobileWorkLog>["entries"];
  readonly workspaceRoot: string | undefined;
}

export function MobileThreadView(props: MobileThreadViewProps) {
  const showEmptyState = shouldShowMobileEmptyState({
    hasConnectionNotice:
      resolveMobileConnectionNotice(props.recoveryState, props.connection) !== null,
    hasPendingApproval: props.composerProps.pendingApproval != null,
    hasPendingUserInput: props.composerProps.pendingUserInput != null,
    hasWorkingIndicator: props.showWorkingIndicator,
    isRunning: props.composerProps.isRunning ?? false,
    messages: props.messages,
    workLogEntryCount: props.workLogEntries.length,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-1 pb-2">
        <MobileConnectionNotice
          connection={props.connection}
          onRetry={props.onRetryRecovery}
          state={props.recoveryState}
        />
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          data-mobile-transcript="true"
          ref={props.messagesScrollRef}
          className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4 py-3 [scrollbar-gutter:stable]"
        >
          <div className="flex min-h-full min-w-0 flex-col" data-mobile-transcript-content="true">
            {props.workLogEntries.length > 0 ? (
              <div className="pt-3">
                <MobileWorkLog entries={props.workLogEntries} />
              </div>
            ) : null}
            <MobileMessages
              cwd={props.workspaceRoot}
              messages={props.messages}
              showEmptyState={showEmptyState}
            />
          </div>
        </div>
        {props.showWorkingIndicator ? (
          <MobileWorkingIndicator
            activeWorkStartedAt={props.activeWorkStartedAt}
            nowIso={props.nowIso}
            verb={props.workingVerb}
          />
        ) : null}
        {!props.isFollowing ? (
          <button
            aria-label="Scroll to latest"
            className="absolute bottom-3 left-1/2 z-30 inline-flex size-11 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-md transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            onClick={props.onScrollToLatest}
            title="Scroll to latest"
            type="button"
          >
            <ArrowDownIcon aria-hidden="true" className="size-4" />
          </button>
        ) : null}
        <div className="pointer-events-none absolute inset-y-0 right-0 z-20 flex w-7 items-center justify-center">
          <MobileReaderOutline {...props.readerOutlineProps} />
        </div>
      </div>
      <div className="shrink-0">
        <MobileComposer {...props.composerProps} />
      </div>
    </div>
  );
}
