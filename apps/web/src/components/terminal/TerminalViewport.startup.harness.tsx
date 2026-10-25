import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { TerminalViewport } from "./TerminalViewport";

/** Exercise both independent terminal IDs through their shared real viewport startup path. */
export function TerminalStartupHarness(input: { cwd: string; executionTargetId?: string }) {
  return (
    <div>
      {["bottom", "right-panel"].map((terminalId) => (
        <div key={terminalId} style={{ width: 600, height: 300 }}>
          <TerminalViewport
            threadId={ThreadId.makeUnsafe("draft-startup-browser")}
            terminalId={terminalId}
            terminalLabel={terminalId}
            cwd={input.cwd}
            executionTargetId={input.executionTargetId}
            runtimeEnv={{ ROOT: input.cwd }}
            worktreePath={input.cwd}
            visible
            autoFocus={false}
            resizeEpoch={0}
            drawerHeight={300}
            focusRequestId={0}
            keybindings={[]}
            onSessionExited={() => undefined}
            onAddTerminalContext={() => undefined}
          />
        </div>
      ))}
    </div>
  );
}
