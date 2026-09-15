import { useEffect, useRef, useState } from "react";

import type { ThreadComposerSurfaceContext } from "~/components/chat/view/ThreadComposerSurface";
import { Button } from "~/components/ui/button";

import { attachCompactScreenshot } from "./compactScreenshotAttachment";

export function CompactChatScreenshotReceiver({
  context,
}: {
  context: ThreadComposerSurfaceContext;
}) {
  const bridge = window.desktopBridge?.compactChatScreenshot;
  const threadId = context.base.threadId;
  const blocked =
    context.thread.pendingUserInputs.length > 0 ||
    context.base.isConnecting ||
    context.thread.isPreparingWorktree;
  const sendInFlight = context.base.sendInFlightRef;
  const deliveredId = useRef<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<{ message: string; captureId?: string } | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    let running = false;
    let requested = false;
    const receive = async () => {
      if (running) {
        requested = true;
        return;
      }
      running = true;
      let captureId: string | undefined;
      try {
        const screenshot = await bridge.getPending(threadId);
        if (disposed) return;
        if (!screenshot) {
          setFailure(null);
          return;
        }
        captureId = screenshot.id;
        if (deliveredId.current !== screenshot.id) {
          if (blocked || sendInFlight.current) {
            throw new Error(
              "Screenshot is waiting. Finish the current send or answer the pending questions, then retry.",
            );
          }
          attachCompactScreenshot(screenshot, threadId);
          deliveredId.current = screenshot.id;
        }
        await bridge.acknowledge(screenshot.id);
        if (!disposed) setFailure(null);
      } catch (error) {
        if (!disposed) {
          setFailure({
            message:
              error instanceof Error
                ? error.message
                : "The screenshot could not be added. Try again.",
            ...(captureId ? { captureId } : {}),
          });
        }
      } finally {
        running = false;
        if (requested && !disposed) {
          requested = false;
          void receive();
        }
      }
    };
    // Subscribe before pulling so a capture cannot fall between these operations.
    const unsubscribe = bridge.onAvailable(() => void receive());
    void receive();
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [attempt, blocked, bridge, sendInFlight, threadId]);

  if (!failure) return null;
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning-foreground"
    >
      <span className="flex-1">{failure.message}</span>
      <Button size="xs" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
        Retry
      </Button>
      {failure.captureId ? (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            void bridge
              ?.acknowledge(failure.captureId!)
              .then(() => {
                setFailure(null);
              })
              .catch(() =>
                setFailure({ ...failure, message: "Could not discard the screenshot. Try again." }),
              );
          }}
        >
          Discard screenshot
        </Button>
      ) : null}
    </div>
  );
}
