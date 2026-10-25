import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import type {
  ExecutionTargetId,
  ResolvedKeybindingsConfig,
  TerminalDropPathMode,
  ThreadId,
} from "@bigbud/contracts";
import type { MutableRefObject, RefObject } from "react";
import type { TerminalContextSelection } from "~/lib/terminalContext";
import type { TerminalTypographySettings } from "./TerminalFontController";
import type { TerminalThemePreference } from "./terminalThemes";
import type { TerminalInteractionSettings } from "./TerminalViewport.addons";
import type { TerminalGpuAcceleration } from "@bigbud/contracts/core/settings.ts";

export interface UseTerminalViewportSessionInput
  extends TerminalTypographySettings, TerminalThemePreference, TerminalInteractionSettings {
  containerRef: RefObject<HTMLDivElement | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  hasHandledExitRef: MutableRefObject<boolean>;
  selectionPointerRef: MutableRefObject<{ x: number; y: number } | null>;
  selectionGestureActiveRef: MutableRefObject<boolean>;
  selectionActionRequestIdRef: MutableRefObject<number>;
  selectionActionOpenRef: MutableRefObject<boolean>;
  selectionActionTimerRef: MutableRefObject<number | null>;
  keybindingsRef: MutableRefObject<ResolvedKeybindingsConfig>;
  autoFocusRef: MutableRefObject<boolean>;
  worktreePathRef: MutableRefObject<string | null | undefined>;
  dropPathModeRef: MutableRefObject<TerminalDropPathMode>;
  threadId: ThreadId;
  visible: boolean;
  terminalId: string;
  readTerminalLabel: () => string;
  executionTargetId?: ExecutionTargetId | undefined;
  cwd: string;
  runtimeEnv?: Record<string, string> | undefined;
  terminalGpuAcceleration: TerminalGpuAcceleration;
  onSessionExited: () => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  onRequestTerminalAnnotation: (input: {
    selection: TerminalContextSelection;
    position: { x: number; y: number };
    selectionRect: { left: number; top: number; right: number; bottom: number } | null;
  }) => void;
}
