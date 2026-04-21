import type { ResolvedKeybindingsConfig } from "@bigbud/contracts";
import { useEffect } from "react";
import { resolveShortcutCommand } from "../../../models/keybindings";
import { isTerminalFocused } from "../../../lib/terminalFocus";
import { projectScriptIdFromCommand } from "../../../logic/project-scripts";
import type { Project } from "../../../models/types";

interface TerminalState {
  terminalOpen: boolean;
  activeTerminalId: string;
}

export interface UseChatKeybindingsInput {
  activeThreadId: string | null;
  activeProject: Project | null | undefined;
  terminalState: TerminalState;
  keybindings: ResolvedKeybindingsConfig;
  toggleTerminalVisibility: () => void;
  setTerminalOpen: (open: boolean) => void;
  splitTerminal: () => void;
  closeTerminal: (terminalId: string) => void;
  createNewTerminal: () => void;
  onToggleDiff: () => void;
  onToggleSearch: () => void;
  runProjectScript: (script: Project["scripts"][number]) => void;
}

/** Registers global keydown handler for all ChatView keyboard shortcuts. */
export function useChatKeybindings({
  activeThreadId,
  activeProject,
  terminalState,
  keybindings,
  toggleTerminalVisibility,
  setTerminalOpen,
  splitTerminal,
  closeTerminal,
  createNewTerminal,
  onToggleDiff,
  onToggleSearch,
  runProjectScript,
}: UseChatKeybindingsInput): void {
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!activeThreadId || event.defaultPrevented) return;
      const shortcutContext = {
        terminalFocus: isTerminalFocused(),
        terminalOpen: Boolean(terminalState.terminalOpen),
      };

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (!command) return;

      if (command === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleTerminalVisibility();
        return;
      }

      if (command === "terminal.split") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal();
        return;
      }

      if (command === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) return;
        closeTerminal(terminalState.activeTerminalId);
        return;
      }

      if (command === "terminal.new") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        createNewTerminal();
        return;
      }

      if (command === "diff.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleDiff();
        return;
      }

      if (command === "search.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleSearch();
        return;
      }

      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject) return;
      const script = activeProject.scripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [
    activeProject,
    terminalState.terminalOpen,
    terminalState.activeTerminalId,
    activeThreadId,
    closeTerminal,
    createNewTerminal,
    setTerminalOpen,
    runProjectScript,
    splitTerminal,
    keybindings,
    onToggleDiff,
    onToggleSearch,
    toggleTerminalVisibility,
  ]);
}
