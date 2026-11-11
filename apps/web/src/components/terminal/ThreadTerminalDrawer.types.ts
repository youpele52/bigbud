import type { ExecutionTargetId, ResolvedKeybindingsConfig, ThreadId } from "@bigbud/contracts";
import type { TerminalContextSelection } from "~/lib/terminalContext";
import type { TerminalAgentKind } from "../../stores/terminal/terminal.store.agentKind";
import type { ThreadTerminalGroup } from "../../models/types";
import type { TerminalProfileLaunch } from "../../lib/terminalProfileLaunch";

export interface ThreadTerminalDrawerProps {
  threadId: ThreadId;
  executionTargetId?: ExecutionTargetId | undefined;
  cwd: string;
  worktreePath?: string | null;
  runtimeEnv?: Record<string, string>;
  visible?: boolean;
  height: number;
  terminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
  focusRequestId: number;
  onSplitTerminal: (
    direction?: import("../../lib/terminalSplitLayout").TerminalSplitDirection,
  ) => void;
  onNewTerminal: (profile?: TerminalProfileLaunch) => void;
  splitShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onHeightChange: (height: number) => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  keybindings: ResolvedKeybindingsConfig;
  terminalBaseLabel: string;
  terminalLabelOverrides: Readonly<Record<string, string>>;
  terminalProviderById: Readonly<Record<string, TerminalAgentKind>>;
  mode?: "drawer" | "panel";
  fillAvailableSpace?: boolean;
  onToggleExpanded?: (() => void) | undefined;
  onMinimize?: (() => void) | undefined;
  onSetTerminalLabelOverride: (terminalId: string, label: string) => void;
  onClearTerminalLabelOverride: (terminalId: string) => void;
}
