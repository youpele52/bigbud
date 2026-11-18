const HINT_TEXT = "Press Esc again to stop";

/**
 * Shown after the first Escape while the double-Escape stop is armed. The live region stays
 * mounted with the Stop button so screen readers announce the text when it appears; the visual
 * bubble is hidden from assistive technology to avoid a duplicate announcement.
 */
export function ComposerEscapeStopHint({ visible }: { readonly visible: boolean }) {
  return (
    <>
      <span role="status" className="sr-only">
        {visible ? HINT_TEXT : ""}
      </span>
      {visible ? (
        <span
          aria-hidden="true"
          data-testid="composer-escape-stop-hint"
          className="pointer-events-none absolute right-0 bottom-full z-20 mb-2 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md/5"
        >
          {HINT_TEXT}
        </span>
      ) : null}
    </>
  );
}
