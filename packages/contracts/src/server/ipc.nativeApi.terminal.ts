import type * as Terminal from "../workspace/terminal";
import type * as TerminalStream from "../workspace/terminal.stream";
import type * as TerminalSearch from "../workspace/terminal.search";
import type * as TerminalRecovery from "../workspace/terminal.recovery";
import type { TerminalWslDistributions } from "../workspace/terminal.wsl";
import type {
  TerminalShellProfileInventory,
  TerminalShellProfilesInput,
} from "../workspace/terminal.shellProfiles";

export interface TerminalNativeApi {
  shellProfiles?: (input: TerminalShellProfilesInput) => Promise<TerminalShellProfileInventory>;
  recovery?: (
    input: TerminalRecovery.TerminalRecoveryInput,
  ) => Promise<TerminalRecovery.TerminalRecoveryResult>;
  wslDistributions?: () => Promise<TerminalWslDistributions>;
  snapshot?: (
    input: typeof Terminal.TerminalSnapshotInput.Encoded,
  ) => Promise<Terminal.TerminalSessionSnapshot>;
  open: (
    input: typeof Terminal.TerminalOpenInput.Encoded,
  ) => Promise<Terminal.TerminalSessionSnapshot>;
  write: (input: typeof Terminal.TerminalWriteInput.Encoded) => Promise<void>;
  resize: (input: typeof Terminal.TerminalResizeInput.Encoded) => Promise<void>;
  clear: (input: typeof Terminal.TerminalClearInput.Encoded) => Promise<void>;
  restart: (
    input: typeof Terminal.TerminalRestartInput.Encoded,
  ) => Promise<Terminal.TerminalSessionSnapshot>;
  close: (input: typeof Terminal.TerminalCloseInput.Encoded) => Promise<void>;
  /** Sidebar/agent state; output only for sessions whose agent detection runs in the client. */
  onEvent: (
    callback: (event: Terminal.TerminalEvent) => void,
    options?: { onInventory?: (inventory: TerminalStream.TerminalSessionInventory) => void },
  ) => () => void;
  /** One terminal's events for a mounted view, flow-controlled by `ackOutput`. */
  subscribeSession?: (
    input: TerminalStream.TerminalSessionStreamInput,
    callback: (item: TerminalStream.TerminalSessionStreamItem) => void,
    options?: { onError?: (error: unknown) => void },
  ) => () => void;
  ackOutput?: (input: TerminalStream.TerminalOutputAckInput) => Promise<void>;
  /** Retained output of the server's terminals, newest lines first. */
  search?: (
    input: TerminalSearch.TerminalSearchInput,
  ) => Promise<TerminalSearch.TerminalSearchResult>;
}
