import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

export const STANDALONE_PAGE_SCROLL_CLASS = "min-h-0 flex-1 overflow-y-auto overscroll-y-contain";
export const STANDALONE_PAGE_CONTAINER_CLASS = "mx-auto w-full max-w-[56rem] px-16 py-7 sm:px-18";

export function StandalonePageContent(props: {
  readonly children: ReactNode;
  readonly className?: string;
  /** Use only for content layout (for example, gap or flex direction), never page padding. */
  readonly contentClassName?: string;
}) {
  return (
    <div className={cn(STANDALONE_PAGE_SCROLL_CLASS, props.className)}>
      <div className={cn(STANDALONE_PAGE_CONTAINER_CLASS, props.contentClassName)}>
        {props.children}
      </div>
    </div>
  );
}
