import type { ExecutionTargetId, NativeApi } from "@bigbud/contracts";
import { type ILink, type Terminal } from "@xterm/xterm";
import {
  extractWrappedTerminalLinkSegments,
  isTerminalLinkActivation,
} from "../../utils/terminal/links.utils";
import { writeSystemMessage } from "./ThreadTerminalDrawer.logic";
import { openTerminalPath } from "./TerminalViewport.links.open";
import { openTerminalWebLink } from "./TerminalViewport.links.web";

interface TerminalLinkProviderOptions {
  terminalRef: { current: Terminal | null };
  cwd: string;
  workspaceRoot: string;
  executionTargetId?: ExecutionTargetId | undefined;
  api: NativeApi;
}

/**
 * Creates a link provider for the xterm.js terminal that handles path and URL links.
 */
export function makeTerminalLinkProvider(options: TerminalLinkProviderOptions) {
  const { terminalRef, cwd, workspaceRoot, executionTargetId, api } = options;

  return {
    provideLinks: (bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) {
        callback(undefined);
        return;
      }

      const line = activeTerminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }

      let logicalStartLineNumber = bufferLineNumber;
      while (logicalStartLineNumber > 1) {
        const previousLine = activeTerminal.buffer.active.getLine(logicalStartLineNumber - 2) as
          | { isWrapped?: boolean }
          | undefined;
        if (!previousLine?.isWrapped) {
          break;
        }
        logicalStartLineNumber -= 1;
      }

      const fragments: Array<{ lineNumber: number; text: string }> = [];
      let currentLineNumber = logicalStartLineNumber;
      while (true) {
        const currentLine = activeTerminal.buffer.active.getLine(currentLineNumber - 1) as
          | { isWrapped?: boolean; translateToString(trimRight?: boolean): string }
          | undefined;
        if (!currentLine) {
          break;
        }
        fragments.push({
          lineNumber: currentLineNumber,
          text: currentLine.translateToString(true),
        });
        const nextLine = activeTerminal.buffer.active.getLine(currentLineNumber) as
          | { isWrapped?: boolean }
          | undefined;
        if (!nextLine?.isWrapped) {
          break;
        }
        currentLineNumber += 1;
      }

      const matches = extractWrappedTerminalLinkSegments(fragments).filter(
        (match) => match.range.start.y === bufferLineNumber,
      );
      if (matches.length === 0) {
        callback(undefined);
        return;
      }

      callback(
        matches.map((match) => ({
          text: match.text,
          range: match.range,
          activate: (event: MouseEvent) => {
            if (!isTerminalLinkActivation(event)) return;

            const latestTerminal = terminalRef.current;
            if (!latestTerminal) return;

            if (match.kind === "url") {
              openTerminalWebLink(match.text);
              return;
            }

            void openTerminalPath({
              api,
              rawPath: match.text,
              cwd,
              workspaceRoot,
              executionTargetId,
            }).catch((error) => {
              const activeTerminal = terminalRef.current;
              if (!activeTerminal) return;
              writeSystemMessage(
                activeTerminal,
                error instanceof Error ? error.message : "Unable to open path",
              );
            });
          },
        })),
      );
    },
  };
}
