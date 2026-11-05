export function MobileQueueNotice({ queuedPromptCount }: { queuedPromptCount: number }) {
  if (queuedPromptCount === 0) return null;

  return (
    <Alert
      aria-live="polite"
      className="pointer-events-none absolute inset-x-2 top-2 z-10 w-auto bg-background/95 px-3 py-2 text-sm shadow-sm"
      role="status"
    >
      <AlertDescription>
        Queued {queuedPromptCount}/5 — will send when the current work settles.
      </AlertDescription>
    </Alert>
  );
}
import { Alert, AlertDescription } from "~/components/ui/alert";
