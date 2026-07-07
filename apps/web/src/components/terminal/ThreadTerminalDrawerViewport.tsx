import {
  type ExecutionTargetId,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@bigbud/contracts";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { TerminalViewport } from "./TerminalViewport";

interface ThreadTerminalDrawerViewportProps {
  threadId: ThreadId;
  executionTargetId: ExecutionTargetId | undefined;
  cwd: string;
  worktreePath: string | null | undefined;
  runtimeEnv: Record<string, string> | undefined;
  visible: boolean;
  visibleTerminalIds: string[];
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
    return (
      <div
        className="grid h-full w-full min-w-0 gap-0 overflow-hidden"
        style={{ gridTemplateColumns: `repeat(${visibleTerminalIds.length}, minmax(0, 1fr))` }}
      >
        {visibleTerminalIds.map((terminalId) => (
          <div
            key={terminalId}
            className={`min-h-0 min-w-0 border-l first:border-l-0 ${
              terminalId === resolvedActiveTerminalId ? "border-border" : "border-border/70"
            }`}
            onMouseDown={() => {
              if (terminalId !== resolvedActiveTerminalId) {
                onActiveTerminalChange(terminalId);
              }
            }}
          >
            <div className="thread-terminal-theme-host h-full bg-background p-1">
              <TerminalViewport
                terminalId={terminalId}
                terminalLabel={terminalLabelById.get(terminalId) ?? "Terminal"}
                onSessionExited={() => onCloseTerminal(terminalId)}
                autoFocus={visible && terminalId === resolvedActiveTerminalId}
                {...sharedProps}
              />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="thread-terminal-theme-host h-full bg-background p-1">
      <TerminalViewport
        key={resolvedActiveTerminalId}
        terminalId={resolvedActiveTerminalId}
        terminalLabel={terminalLabelById.get(resolvedActiveTerminalId) ?? "Terminal"}
        onSessionExited={() => onCloseTerminal(resolvedActiveTerminalId)}
        autoFocus={visible}
        {...sharedProps}
      />
    </div>
  );
}
