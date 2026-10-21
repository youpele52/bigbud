import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { ResolvedKeybindingsConfig } from "@bigbud/contracts/server/keybindings.ts";
import type { TerminalFontFamily } from "@bigbud/contracts/core/settings.ts";
import { useTerminalViewportSession } from "./TerminalViewport.session";
import {
  bundledTerminalFontFromSettings,
  terminalFontFamilyFromSettings,
  terminalLineHeightFromSettings,
} from "./terminalTypography";

/** Real hook fixture; terminal lifecycle is observed without mocking xterm internals. */
export function TerminalSessionFixture(input: {
  fontSize: number;
  fontFamily?: TerminalFontFamily;
  visible?: boolean;
  gpu?: "off" | "on";
  hiddenLayout?: "none" | "visibility";
  onFitAddon?: (addon: FitAddon | null) => void;
  onTerminal: (terminal: Terminal | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const hasHandledExitRef = useRef(false);
  const selectionPointerRef = useRef<{ x: number; y: number } | null>(null);
  const selectionGestureActiveRef = useRef(false);
  const selectionActionRequestIdRef = useRef(0);
  const selectionActionOpenRef = useRef(false);
  const selectionActionTimerRef = useRef<number | null>(null);
  const keybindingsRef = useRef<ResolvedKeybindingsConfig>([]);
  const autoFocusRef = useRef(false);
  const worktreePathRef = useRef(null);
  const dropPathModeRef = useRef<"posix">("posix");
  const state = useTerminalViewportSession({
    containerRef,
    terminalRef,
    fitAddonRef,
    hasHandledExitRef,
    selectionPointerRef,
    selectionGestureActiveRef,
    selectionActionRequestIdRef,
    selectionActionOpenRef,
    selectionActionTimerRef,
    keybindingsRef,
    autoFocusRef,
    worktreePathRef,
    dropPathModeRef,
    threadId: ThreadId.makeUnsafe("terminal-fixture"),
    visible: input.visible ?? true,
    terminalId: "synthetic",
    readTerminalLabel: () => "synthetic",
    cwd: "/synthetic",
    terminalFontFamily: terminalFontFamilyFromSettings(input.fontFamily ?? "system-monospace"),
    terminalFontSize: input.fontSize,
    bundledTerminalFont: bundledTerminalFontFromSettings(input.fontFamily ?? "system-monospace"),
    terminalLineHeight: terminalLineHeightFromSettings(input.fontFamily ?? "system-monospace"),
    terminalGpuAcceleration: input.gpu ?? "off",
    terminalThemeDark: "bigbud",
    terminalThemeLight: "bigbud",
    terminalScrollSensitivity: 1.15,
    terminalFastScrollSensitivity: 5,
    terminalTuiScrollSensitivity: 1,
    terminalLigatures: "off",
    terminalInlineImages: false,
    onSessionExited: () => undefined,
    onAddTerminalContext: () => undefined,
    onRequestTerminalAnnotation: () => undefined,
  });
  useEffect(() => {
    input.onTerminal(terminalRef.current);
    input.onFitAddon?.(fitAddonRef.current);
  });
  return (
    <div
      style={{
        display: input.visible === false && input.hiddenLayout === "none" ? "none" : undefined,
        visibility:
          input.visible === false && input.hiddenLayout === "visibility" ? "hidden" : undefined,
      }}
    >
      <div ref={containerRef} style={{ width: 600, height: 300 }} />
      <span>{state.inputEnabled ? "ready" : "paused"}</span>
      <span>{state.rendering.mode}</span>
    </div>
  );
}
