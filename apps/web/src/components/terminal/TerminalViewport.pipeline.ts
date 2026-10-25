import type { Terminal } from "@xterm/xterm";
import { LOCAL_EXECUTION_TARGET_ID } from "@bigbud/contracts/core/baseSchemas";
import { isWindowsPlatform } from "~/lib/utils";
import { removeTransientCursorShowSequences } from "./terminalCursorSequencing";
import { TerminalRenderRepair } from "./TerminalRenderRepair";
import type { TerminalWriteBatcherOptions } from "./TerminalWriteBatcher";

export interface TerminalOutputPipelineInput {
  readonly terminal: Terminal;
  readonly executionTargetId?: string | undefined;
  readonly isWebgl: () => boolean;
  readonly lastInputAt: () => number;
  readonly platform?: string;
}

/** A local PTY on a Windows client runs behind ConPTY (Orca gates its rewrite fixes on this). */
export function isNativeWindowsConpty(platform: string, executionTargetId?: string): boolean {
  return (
    isWindowsPlatform(platform) &&
    (executionTargetId ?? LOCAL_EXECUTION_TARGET_ID) === LOCAL_EXECUTION_TARGET_ID
  );
}

/**
 * Per-view output hooks shared by every delivery lane of the view: the foreground render repair,
 * ConPTY cursor sequencing, and the immediate write path. Visibility pacing is set on each lane.
 */
export function createTerminalOutputPipeline(input: TerminalOutputPipelineInput) {
  const platform = input.platform ?? (typeof navigator === "undefined" ? "" : navigator.platform);
  const windowsClient = isWindowsPlatform(platform);
  const nativeWindowsConpty = isNativeWindowsConpty(platform, input.executionTargetId);
  const repair = new TerminalRenderRepair(input.terminal, {
    isWebgl: input.isWebgl,
    lastInputAt: input.lastInputAt,
    windowsClient,
    nativeWindowsConpty,
  });
  const batcherOptions: TerminalWriteBatcherOptions = {
    immediateForeground: true,
    prepareWrite: (data) => repair.prepare(data),
    ...(nativeWindowsConpty ? { transformWrite: removeTransientCursorShowSequences } : {}),
  };
  return {
    batcherOptions,
    dispose: () => repair.dispose(),
  };
}
