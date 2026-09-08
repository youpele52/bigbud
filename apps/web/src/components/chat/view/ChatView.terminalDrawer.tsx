import type { ResolvedKeybindingsConfig, ThreadId } from "@bigbud/contracts";
import { useCallback, useEffect, useState } from "react";

import { cn } from "~/lib/utils";

import { useThreadTerminalDrawer } from "../../terminal/useThreadTerminalDrawer";
import ThreadTerminalDrawer from "../../terminal/ThreadTerminalDrawer";
import type { TerminalContextSelection } from "../../../lib/terminalContext";

interface PersistentThreadTerminalDrawerProps {
  threadId: ThreadId;
  visible: boolean;
  presentation?: "split" | "fill" | "hidden";
  launchContext: PersistentTerminalLaunchContext | null;
  focusRequestId: number;
  splitShortcutLabel: string | undefined;
  newShortcutLabel: string | undefined;
  closeShortcutLabel: string | undefined;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

interface PersistentTerminalLaunchContext {
  cwd: string;
  worktreePath: string | null;
}

export function PersistentThreadTerminalDrawer({
  threadId,
  visible,
  presentation = "split",
  launchContext,
  focusRequestId,
  splitShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  keybindings,
  onAddTerminalContext,
}: PersistentThreadTerminalDrawerProps) {
  const drawer = useThreadTerminalDrawer(threadId, launchContext, visible);
  const project = drawer.project;
  const cwd = drawer.cwd;
  const drawerOpen = drawer.terminalState.terminalOpen;
  const canRenderDrawer = Boolean(project && cwd);
  const animatedVisible = visible && drawerOpen;
  const terminalVisible = animatedVisible && presentation !== "hidden";
  const [shouldRender, setShouldRender] = useState(() => canRenderDrawer && animatedVisible);
  const [isTransitionVisible, setIsTransitionVisible] = useState(
    () => canRenderDrawer && animatedVisible,
  );

  useEffect(() => {
    if (canRenderDrawer && animatedVisible) {
      setShouldRender(true);
      const frameId = requestAnimationFrame(() => {
        setIsTransitionVisible(true);
      });
      return () => {
        cancelAnimationFrame(frameId);
      };
    }
    setIsTransitionVisible(false);
  }, [animatedVisible, canRenderDrawer]);

  const handleAddTerminalContext = useCallback(
    (selection: TerminalContextSelection) => {
      if (!visible) {
        return;
      }
      onAddTerminalContext(selection);
    },
    [onAddTerminalContext, visible],
  );

  if (!project || !cwd || !shouldRender) {
    return null;
  }

  return (
    <div
      aria-hidden={!terminalVisible}
      inert={!terminalVisible || undefined}
      data-terminal-presentation={presentation}
      className={cn(
        "overflow-hidden transition-[max-height,opacity,transform] duration-[380ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[max-height,opacity,transform]",
        presentation === "fill" && "min-h-0 flex-1",
        presentation === "hidden" && "hidden pointer-events-none",
        isTransitionVisible
          ? "translate-y-0 opacity-100"
          : "pointer-events-none translate-y-3 opacity-0",
      )}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        if (!isTransitionVisible) {
          setShouldRender(false);
        }
      }}
      style={{
        maxHeight:
          presentation === "fill"
            ? undefined
            : isTransitionVisible
              ? `${drawer.terminalState.terminalHeight}px`
              : "0px",
      }}
    >
      <ThreadTerminalDrawer
        threadId={threadId}
        executionTargetId={drawer.executionTargetId}
        cwd={cwd}
        worktreePath={drawer.effectiveWorktreePath}
        runtimeEnv={drawer.runtimeEnv}
        visible={terminalVisible}
        height={drawer.terminalState.terminalHeight}
        terminalIds={drawer.terminalState.terminalIds}
        activeTerminalId={drawer.terminalState.activeTerminalId}
        terminalGroups={drawer.terminalState.terminalGroups}
        activeTerminalGroupId={drawer.terminalState.activeTerminalGroupId}
        focusRequestId={focusRequestId + drawer.focusRequestId}
        onSplitTerminal={drawer.splitTerminal}
        onNewTerminal={drawer.createNewTerminal}
        splitShortcutLabel={animatedVisible ? splitShortcutLabel : undefined}
        newShortcutLabel={animatedVisible ? newShortcutLabel : undefined}
        closeShortcutLabel={animatedVisible ? closeShortcutLabel : undefined}
        keybindings={keybindings}
        terminalBaseLabel={drawer.terminalBaseLabel}
        terminalLabelOverrides={drawer.terminalLabelOverrides}
        terminalProviderById={drawer.terminalProviderById}
        onActiveTerminalChange={drawer.activateTerminal}
        onCloseTerminal={drawer.closeTerminal}
        onSetTerminalLabelOverride={drawer.setTerminalLabelOverride}
        onClearTerminalLabelOverride={drawer.clearTerminalLabelOverride}
        onHeightChange={drawer.setTerminalHeight}
        onAddTerminalContext={handleAddTerminalContext}
        fillAvailableSpace={presentation === "fill"}
      />
    </div>
  );
}
