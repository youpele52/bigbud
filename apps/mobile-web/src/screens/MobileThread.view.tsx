import type { ComponentProps, RefObject } from "react";

import type { MobileRecoveryState } from "../logic/mobileRecovery.types";

import { MobileConnectionNotice } from "../components/shell/MobileConnectionNotice";
import { MobileComposer } from "../components/threads/thread/composer/MobileComposer";
import { MobileWorkingIndicator } from "../components/threads/thread/composer/MobileWorkingIndicator";
import { MobileMessages } from "../components/threads/thread/MobileMessages";
import { MobileReaderOutline } from "../components/threads/thread/MobileReaderOutline";
import { MobileWorkLog } from "../components/threads/thread/MobileWorkLog";

interface MobileThreadViewProps {
  readonly activeWorkStartedAt: string | null;
  readonly composerProps: ComponentProps<typeof MobileComposer>;
  readonly messages: ComponentProps<typeof MobileMessages>["messages"];
  readonly messagesScrollRef: RefObject<HTMLDivElement | null>;
  readonly recoveryState: MobileRecoveryState;
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
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-1 pb-2">
        <MobileConnectionNotice onRetry={props.onRetryRecovery} state={props.recoveryState} />
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          data-mobile-transcript="true"
          ref={props.messagesScrollRef}
          className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain pb-3 [scrollbar-gutter:stable]"
        >
          <div data-mobile-transcript-content="true">
            {props.workLogEntries.length > 0 ? (
              <div className="pt-3">
                <MobileWorkLog entries={props.workLogEntries} />
              </div>
            ) : null}
            <MobileMessages cwd={props.workspaceRoot} messages={props.messages} />
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
            className="absolute right-9 bottom-3 z-30 min-h-11 rounded-full border border-border bg-card px-3 text-xs font-medium text-foreground shadow-md"
            onClick={props.onScrollToLatest}
            type="button"
          >
            Latest
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
