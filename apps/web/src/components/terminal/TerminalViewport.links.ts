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

      const buffer = activeTerminal.buffer.active;
      const bufferLength = buffer.length;
      if (
        !Number.isInteger(bufferLineNumber) ||
        bufferLineNumber < 1 ||
        bufferLineNumber > bufferLength
      ) {
        callback(undefined);
        return;
      }
      const line = buffer.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }

      let logicalStartLineNumber = bufferLineNumber;
      while (logicalStartLineNumber > 1) {
        // isWrapped describes this row's continuation from the previous row.
        const currentLine = buffer.getLine(logicalStartLineNumber - 1);
        if (!currentLine?.isWrapped) {
          break;
        }
        logicalStartLineNumber -= 1;
      }

      const fragments: Array<{ lineNumber: number; text: string }> = [];
      let currentLineNumber = logicalStartLineNumber;
      // Never probe past length: circular backing storage can alias earlier rows there.
      while (currentLineNumber <= bufferLength) {
        const currentLine = buffer.getLine(currentLineNumber - 1);
        if (!currentLine) {
          break;
        }
        fragments.push({
          lineNumber: currentLineNumber,
          text: currentLine.translateToString(true),
        });
        if (currentLineNumber === bufferLength) {
          break;
        }
        const nextLine = buffer.getLine(currentLineNumber);
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
