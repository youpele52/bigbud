import { useEffect } from "react";
import { type ThreadId, type ResolvedKeybindingsConfig } from "@bigbud/contracts";
import { isTerminalFocused } from "../../lib/terminalFocus";
import {
  resolveShortcutCommand,
  shouldShowThreadJumpHints,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../../models/keybindings";
import { resolveAdjacentThreadId } from "./Sidebar.logic";

interface UseSidebarKeyboardNavOptions {
  keybindings: ResolvedKeybindingsConfig;
  platform: string;
  routeTerminalOpen: boolean;
  routeThreadId: ThreadId | null;
  orderedSidebarThreadIds: readonly ThreadId[];
  threadJumpThreadIds: ThreadId[];
  navigateToThread: (threadId: ThreadId) => void;
  updateThreadJumpHintsVisibility: (shouldShow: boolean) => void;
}

/** Registers window keyboard event listeners for thread traversal and jump hints. */
export function useSidebarKeyboardNav({
  keybindings,
  platform,
  routeTerminalOpen,
  routeThreadId,
  orderedSidebarThreadIds,
  threadJumpThreadIds,
  navigateToThread,
  updateThreadJumpHintsVisibility,
}: UseSidebarKeyboardNavOptions): void {
  useEffect(() => {
    const getShortcutContext = () => ({
      terminalFocus: isTerminalFocused(),
      terminalOpen: routeTerminalOpen,
    });

    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      updateThreadJumpHintsVisibility(
        shouldShowThreadJumpHints(event, keybindings, {
          platform,
          context: getShortcutContext(),
        }),
      );

      if (event.defaultPrevented || event.repeat) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform,
        context: getShortcutContext(),
      });
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        const targetThreadId = resolveAdjacentThreadId({
          threadIds: orderedSidebarThreadIds,
          currentThreadId: routeThreadId,
          direction: traversalDirection,
        });
        if (!targetThreadId) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        navigateToThread(targetThreadId);
        return;
      }

      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }

      const targetThreadId = threadJumpThreadIds[jumpIndex];
      if (!targetThreadId) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      navigateToThread(targetThreadId);
    };

    const onWindowKeyUp = (event: globalThis.KeyboardEvent) => {
      updateThreadJumpHintsVisibility(
        shouldShowThreadJumpHints(event, keybindings, {
          platform,
          context: getShortcutContext(),
        }),
      );
    };

    const onWindowBlur = () => {
      updateThreadJumpHintsVisibility(false);
    };

    window.addEventListener("keydown", onWindowKeyDown, { capture: true });
    window.addEventListener("keyup", onWindowKeyUp, { capture: true });
    window.addEventListener("blur", onWindowBlur);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, { capture: true });
      window.removeEventListener("keyup", onWindowKeyUp, { capture: true });
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [
    keybindings,
    navigateToThread,
    orderedSidebarThreadIds,
    platform,
    routeTerminalOpen,
    routeThreadId,
    threadJumpThreadIds,
    updateThreadJumpHintsVisibility,
  ]);
}
