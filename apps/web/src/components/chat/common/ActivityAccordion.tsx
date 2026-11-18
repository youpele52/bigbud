import { ChevronDownIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { ACTIVITY_LAYOUT } from "~/constants/activityLayout";
import { cn } from "~/lib/utils";

/** Section headers for work logs, subagents, thinking, and the other activity labels. */
export const activitySectionLabelTypography =
  "font-normal text-[10px] uppercase leading-none tracking-[0.14em] text-muted-foreground/55 sm:text-[10px]";

export type ActivityAccordionVariant = "section" | "compact";

export interface ActivityAccordionProps extends Omit<ComponentProps<"details">, "title"> {
  /** Header label, e.g. "Question" (uppercase in `section`, sentence case in `compact`). */
  readonly title: ReactNode;
  /** Secondary header content after the title, e.g. a `<time>`. */
  readonly meta?: ReactNode;
  /**
   * `section` is a divided timeline row header; `compact` is an inline muted `text-xs`
   * toggle without a divider, for disclosures nested inside messages or work entries.
   */
  readonly variant?: ActivityAccordionVariant;
  /**
   * Controls pinned to the top-right of the header, e.g. "Show N more". They sit outside
   * `<summary>` (so clicks never toggle it) and only show while the accordion is open.
   */
  readonly actions?: ReactNode;
  /** Copy and other entry actions available even while collapsed. */
  readonly persistentActions?: ReactNode;
  readonly summaryClassName?: string;
  readonly panelClassName?: string;
}

// Center the icon against capital letters, not the font's ascender/descender space.
const HEADER_TEXT_CLASS_NAME = "[text-box-edge:cap_alphabetic] [text-box-trim:trim-both]";
// Header row height: the icon box plus the summary's py-2.
const ACTIONS_CLASS_NAME =
  "absolute top-0 right-0 flex h-[calc(1cap+4px+1rem)] items-center text-[10px] leading-none";
// Hang the icon from the text baseline, 2px below it with 2px spare on each side of the
// cap height, so both snap to pixels together. A box-centered icon drifts up to 1px
// against the glyphs when the row lands on a fractional offset.
const HEADER_ICON_CLASS_NAME = "relative top-[2px] size-[calc(1cap+4px)]";

const SUMMARY_BASE_CLASS_NAME =
  "flex cursor-pointer list-none items-baseline outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden";

const VARIANT_CLASS_NAMES = {
  section: {
    details: "border-b border-border/60 pb-2",
    summary: cn(
      "gap-1.5 hover:text-foreground",
      ACTIVITY_LAYOUT.sectionSummary,
      activitySectionLabelTypography,
    ),
    panel: ACTIVITY_LAYOUT.sectionPanel,
  },
  compact: {
    details: ACTIVITY_LAYOUT.compact,
    summary:
      "w-fit gap-1 text-xs leading-none font-normal text-muted-foreground/55 hover:text-muted-foreground/75",
    panel: ACTIVITY_LAYOUT.compactPanel,
  },
} as const satisfies Record<
  ActivityAccordionVariant,
  { details: string; summary: string; panel: string }
>;

/**
 * Timeline disclosure for activities (questions, work logs, thinking, tool or terminal
 * calls). Uncontrolled it starts collapsed; pass `open`/`onToggle` (see
 * `ActivityAccordion.state.ts`) to persist it. The chevron follows only its own
 * `<details>`, so accordions nest.
 */
export function ActivityAccordion({
  title,
  meta,
  variant = "section",
  actions,
  persistentActions,
  children,
  className,
  summaryClassName,
  panelClassName,
  ...detailsProps
}: ActivityAccordionProps) {
  const variantClassNames = VARIANT_CLASS_NAMES[variant];
  const actionsRef = useRef<HTMLDivElement>(null);
  const [actionsWidth, setActionsWidth] = useState(0);
  const hasActions = actions !== undefined || persistentActions !== undefined;
  useLayoutEffect(() => {
    const element = actionsRef.current;
    if (!element) {
      setActionsWidth(0);
      return;
    }
    const observer = new ResizeObserver(() =>
      setActionsWidth(element.getBoundingClientRect().width),
    );
    setActionsWidth(element.getBoundingClientRect().width);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasActions]);
  return (
    <div className="relative [&:not(:has(>details[open]))>[data-slot=activity-accordion-actions]>[data-open-only]]:hidden">
      <details
        data-slot="activity-accordion"
        data-variant={variant}
        className={cn("relative", variantClassNames.details, className)}
        {...detailsProps}
      >
        <summary
          className={cn(SUMMARY_BASE_CLASS_NAME, variantClassNames.summary, summaryClassName)}
          style={actionsWidth ? { paddingRight: actionsWidth + 8 } : undefined}
        >
          <span
            data-slot="activity-accordion-title"
            className={cn("min-w-0 [overflow-wrap:anywhere]", HEADER_TEXT_CLASS_NAME)}
          >
            {title}
          </span>
          {meta === undefined ? null : (
            <span
              data-slot="activity-accordion-meta"
              className={cn("min-w-0 [overflow-wrap:anywhere]", HEADER_TEXT_CLASS_NAME)}
            >
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
        <div
          data-slot="activity-accordion-panel"
          className={cn(variantClassNames.panel, panelClassName)}
        >
          {children}
        </div>
      </details>
      {actions === undefined && persistentActions === undefined ? null : (
        <div
          ref={actionsRef}
          data-slot="activity-accordion-actions"
          className={cn(ACTIONS_CLASS_NAME, "gap-2")}
        >
          {persistentActions}
          {actions === undefined ? null : <div data-open-only>{actions}</div>}
        </div>
      )}
    </div>
  );
}
