import type { ThreadId } from "@bigbud/contracts";
import type { ComputerUseDeliveryMode } from "@bigbud/contracts/core/settings.computerUsePolicy";
import { Effect } from "effect";

import type { CuaDriverShape } from "../Services/CuaDriver.ts";
import { ComputerUseError } from "../Services/ComputerUse.ts";
import {
  desktopWindows,
  pickFrontmostWindow,
  type WindowRef,
} from "./ComputerUse.desktop.target.ts";
import { toError } from "./ComputerUse.desktop.results.ts";

const TARGET_TTL_MS = 30 * 60_000;
const MAX_TARGETS = 256;

/** Bounded per-service targets; eviction never permits a mutation to adopt another window. */
export function createDesktopTargets() {
  const entries = new Map<ThreadId, { window: WindowRef; touchedAt: number }>();
  return {
    get(threadId: ThreadId): WindowRef | undefined {
      const entry = entries.get(threadId);
      if (!entry) return undefined;
      if (Date.now() - entry.touchedAt > TARGET_TTL_MS) {
        entries.delete(threadId);
        return undefined;
      }
      return entry.window;
    },
    set(threadId: ThreadId, window: WindowRef): void {
      entries.delete(threadId);
      if (entries.size >= MAX_TARGETS) entries.delete(entries.keys().next().value!);
      entries.set(threadId, { window, touchedAt: Date.now() });
    },
    delete(threadId: ThreadId): void {
      entries.delete(threadId);
    },
    clear(): void {
      entries.clear();
    },
  };
}

export interface DesktopInteraction {
  readonly deliveryMode: ComputerUseDeliveryMode;
  readonly targets: ReturnType<typeof createDesktopTargets>;
}

export function backgroundUnavailable(message: string): ComputerUseError {
  return new ComputerUseError({
    message: `${message} Select a running app with focus_app, or choose Foreground in Settings → Computer Use. Background mode never switches focus automatically.`,
  });
}

/** Resolve a retained identity, never the user's newly focused window, during background work. */
export const resolveDesktopTarget = Effect.fn("resolveDesktopTarget")(function* (
  threadId: ThreadId,
  driver: CuaDriverShape,
  interaction: DesktopInteraction,
  allowInitialCapture: boolean,
) {
  const result = yield* driver
    .callTool("list_windows", {})
    .pipe(Effect.mapError((cause) => toError(cause, "Failed to read desktop windows.")));
  if (interaction.deliveryMode === "foreground") {
    interaction.targets.delete(threadId);
    return pickFrontmostWindow(result.structuredContent);
  }
  const retained = interaction.targets.get(threadId);
  if (retained) {
    const matches = desktopWindows(result.structuredContent).filter(
      (window) =>
        window.pid === retained.pid &&
        window.windowId === retained.windowId &&
        (!retained.appName || window.appName === retained.appName),
    );
    if (matches.length !== 1) {
      return yield* backgroundUnavailable("The selected background window is no longer available.");
    }
    const window = matches[0]!;
    if (
      !allowInitialCapture &&
      (window.bounds?.width !== retained.bounds?.width ||
        window.bounds?.height !== retained.bounds?.height)
    ) {
      return yield* backgroundUnavailable(
        "The selected window changed size. Capture it again before acting.",
      );
    }
    interaction.targets.set(threadId, window);
    return window;
  }
  if (!allowInitialCapture) {
    return yield* backgroundUnavailable(
      "No background target is selected. Capture a window first.",
    );
  }
  const window = pickFrontmostWindow(result.structuredContent);
  if (window) interaction.targets.set(threadId, window);
  return window;
});
