export function MobileQueueNotice({ queuedPromptCount }: { queuedPromptCount: number }) {
  if (queuedPromptCount === 0) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none absolute inset-x-2 top-2 z-10 rounded-md border border-border bg-background/95 px-3 py-2 text-center text-sm text-muted-foreground shadow-sm"
      role="status"
    >
      Queued {queuedPromptCount}/5 — will send when the current work settles.
    </div>
  );
}
