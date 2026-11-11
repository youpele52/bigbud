import {
  normalizeTerminalSplitLayout,
  terminalSplitBounds,
  type TerminalSplitLayout,
} from "../../lib/terminalSplitLayout";
import {
  type ExecutionTargetId,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@bigbud/contracts";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { TerminalViewport } from "./TerminalViewport";
import { TerminalViewportErrorBoundary } from "./TerminalViewportErrorBoundary";

interface ThreadTerminalDrawerViewportProps {
  threadId: ThreadId;
  executionTargetId: ExecutionTargetId | undefined;
  cwd: string;
  worktreePath: string | null | undefined;
  runtimeEnv: Record<string, string> | undefined;
  visible: boolean;
  visibleTerminalIds: string[];
  splitLayout?: TerminalSplitLayout | undefined;
  resolvedActiveTerminalId: string;
  terminalLabelById: ReadonlyMap<string, string>;
  focusRequestId: number;
  resizeEpoch: number;
  drawerHeight: number;
  keybindings: ResolvedKeybindingsConfig;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

export function ThreadTerminalDrawerViewport({
  threadId,
  executionTargetId,
  cwd,
  worktreePath,
  runtimeEnv,
  visible,
  visibleTerminalIds,
  splitLayout,
  resolvedActiveTerminalId,
  terminalLabelById,
  focusRequestId,
  resizeEpoch,
  drawerHeight,
  keybindings,
  onActiveTerminalChange,
  onCloseTerminal,
  onAddTerminalContext,
}: ThreadTerminalDrawerViewportProps) {
  const sharedProps = {
    threadId,
    visible,
    executionTargetId,
    cwd,
    ...(worktreePath !== undefined ? { worktreePath } : {}),
    ...(runtimeEnv ? { runtimeEnv } : {}),
    onAddTerminalContext,
    focusRequestId,
    resizeEpoch,
    drawerHeight,
    keybindings,
  };

  if (visibleTerminalIds.length > 1) {
    const bounds = terminalSplitBounds(
      normalizeTerminalSplitLayout(splitLayout, visibleTerminalIds),
    );
    return (
      <div className="relative h-full w-full min-w-0 overflow-hidden">
        {visibleTerminalIds.map((terminalId) => (
          <div
            key={terminalId}
            style={Object.fromEntries(
              Object.entries(bounds.get(terminalId)!).map(([key, value]) => [key, `${value}%`]),
            )}
            className={`absolute min-h-0 min-w-0 ${bounds.get(terminalId)!.left > 0 ? "border-l" : ""} ${bounds.get(terminalId)!.top > 0 ? "border-t" : ""} ${
              terminalId === resolvedActiveTerminalId ? "border-border" : "border-border/70"
            }`}
            onFocusCapture={() => {
              if (terminalId !== resolvedActiveTerminalId) onActiveTerminalChange(terminalId);
            }}
            onMouseDown={() => {
              if (terminalId !== resolvedActiveTerminalId) {
                onActiveTerminalChange(terminalId);
              }
            }}
          >
            <div className="thread-terminal-theme-host h-full bg-background p-1">
              <TerminalViewportErrorBoundary
                terminalLabel={terminalLabelById.get(terminalId) ?? "Terminal"}
              >
                <TerminalViewport
                  terminalId={terminalId}
                  terminalLabel={terminalLabelById.get(terminalId) ?? "Terminal"}
                  onSessionExited={() => onCloseTerminal(terminalId)}
                  autoFocus={visible && terminalId === resolvedActiveTerminalId}
                  {...sharedProps}
                />
              </TerminalViewportErrorBoundary>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="thread-terminal-theme-host h-full bg-background p-1">
      <TerminalViewportErrorBoundary
        key={resolvedActiveTerminalId}
        terminalLabel={terminalLabelById.get(resolvedActiveTerminalId) ?? "Terminal"}
      >
        <TerminalViewport
          terminalId={resolvedActiveTerminalId}
          terminalLabel={terminalLabelById.get(resolvedActiveTerminalId) ?? "Terminal"}
          onSessionExited={() => onCloseTerminal(resolvedActiveTerminalId)}
          autoFocus={visible}
          {...sharedProps}
        />
      </TerminalViewportErrorBoundary>
    </div>
  );
}
