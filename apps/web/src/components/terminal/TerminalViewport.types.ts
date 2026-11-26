import type { ExecutionTargetId, ResolvedKeybindingsConfig, ThreadId } from "@bigbud/contracts";
import type { TerminalContextSelection } from "~/lib/terminalContext";

export interface TerminalViewportProps {
  threadId: ThreadId;
  visible: boolean;
  terminalId: string;
  terminalLabel: string;
  executionTargetId?: ExecutionTargetId | undefined;
  cwd: string;
  worktreePath?: string | null;
  runtimeEnv?: Record<string, string>;
  onSessionExited: () => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  focusRequestId: number;
  autoFocus: boolean;
  resizeEpoch: number;
  drawerHeight: number;
  keybindings: ResolvedKeybindingsConfig;
}

/** The registry-owned view also reports whether the host can restore it exactly. */
export interface TerminalViewportSurfaceProps extends TerminalViewportProps {
  onRestorableChange?: ((restorable: boolean) => void) | undefined;
}
