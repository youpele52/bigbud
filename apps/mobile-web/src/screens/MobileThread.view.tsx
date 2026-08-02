import type { ComponentProps, RefObject } from "react";

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
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={props.messagesScrollRef}
          className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain pb-44 [scrollbar-gutter:stable]"
        >
          {props.workLogEntries.length > 0 ? (
            <div className="pt-3">
              <MobileWorkLog entries={props.workLogEntries} />
            </div>
          ) : null}
          <MobileMessages cwd={props.workspaceRoot} messages={props.messages} />
        </div>
        {props.showWorkingIndicator ? (
          <MobileWorkingIndicator
            activeWorkStartedAt={props.activeWorkStartedAt}
            nowIso={props.nowIso}
            verb={props.workingVerb}
          />
        ) : null}
        <div className="pointer-events-none absolute top-0 right-0 bottom-[calc(11rem+env(safe-area-inset-bottom))] z-20 flex w-7 items-center justify-center">
          <MobileReaderOutline {...props.readerOutlineProps} />
        </div>
      </div>
      <MobileComposer {...props.composerProps} />
    </div>
  );
}
