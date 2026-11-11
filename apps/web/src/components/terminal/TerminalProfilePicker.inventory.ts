import type { NativeApi } from "@bigbud/contracts/server/ipc.nativeApi.ts";
import type { TerminalShellProfileInventory } from "@bigbud/contracts/workspace/terminal.shellProfiles.ts";

/** A scoped request fence. No desktop fallback and no shared cross-pane cache. */
export function createTerminalProfileInventoryLoader(
  readApi: () => NativeApi | undefined,
  publish: (state: {
    inventory?: TerminalShellProfileInventory;
    error?: string;
    loading: boolean;
  }) => void,
) {
  let revision = 0;
  return {
    invalidate: () => {
      revision += 1;
    },
    async load(threadId: string, terminalId: string) {
      const request = ++revision;
      publish({ loading: true });
      try {
        const api = readApi();
        if (!api?.terminal.shellProfiles)
          throw new Error("Shell profile discovery is unavailable on this server.");
        const inventory = await api.terminal.shellProfiles({ threadId, terminalId });
        if (request === revision) publish({ inventory, loading: false });
      } catch (cause) {
        if (request === revision)
          publish({
            error:
              cause instanceof Error
                ? cause.message
                : "Shell profile discovery failed. Retry this menu.",
            loading: false,
          });
      }
    },
  };
}
