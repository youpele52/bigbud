import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { textButtonTypography } from "../../ui/button";
import { cn } from "~/lib/utils";

export interface ActivityAccordionProps extends Omit<ComponentProps<"details">, "title"> {
  /** Uppercase header label, e.g. "Question". */
  readonly title: ReactNode;
  /** Secondary header content after the title, e.g. a `<time>`. */
  readonly meta?: ReactNode;
  readonly summaryClassName?: string;
  readonly panelClassName?: string;
}

// Center the icon against capital letters, not the font's ascender/descender space.
const HEADER_TEXT_CLASS_NAME = "[text-box-edge:cap_alphabetic] [text-box-trim:trim-both]";
// Hang the icon from the text baseline, 2px below it with 2px spare on each side of the
// cap height, so both snap to pixels together. A box-centered icon drifts up to 1px
// against the glyphs when the row lands on a fractional offset.
const HEADER_ICON_CLASS_NAME = "relative top-[2px] size-[calc(1cap+4px)]";

/**
 * Collapsed-by-default timeline disclosure for finished activities (questions, work logs,
 * tool or terminal calls). The chevron follows only its own `<details>`, so accordions nest.
 */
export function ActivityAccordion({
  title,
  meta,
  children,
  className,
  summaryClassName,
  panelClassName,
  ...detailsProps
}: ActivityAccordionProps) {
  return (
    <details
      data-slot="activity-accordion"
      className={cn("border-b border-border/60 pb-2", className)}
      {...detailsProps}
    >
      <summary
        className={cn(
          "flex cursor-pointer list-none items-baseline gap-1.5 py-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden",
          textButtonTypography,
          "text-[10px] leading-none tracking-[0.14em] sm:text-[10px]",
          summaryClassName,
        )}
      >
        <span data-slot="activity-accordion-title" className={HEADER_TEXT_CLASS_NAME}>
          {title}
        </span>
        {meta === undefined ? null : (
          <span data-slot="activity-accordion-meta" className={HEADER_TEXT_CLASS_NAME}>
            {meta}
          </span>
        )}
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            "block shrink-0 -rotate-90 transition-transform [details[open]>summary>&]:rotate-0",
            HEADER_ICON_CLASS_NAME,
          )}
        />
      </summary>
      <div data-slot="activity-accordion-panel" className={cn("pb-2 pt-3", panelClassName)}>
        {children}
      </div>
    </details>
  );
}
