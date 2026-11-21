import type * as RemoteTerminal from "../workspace/terminal.remote";
import type * as ShellOwners from "../workspace/terminal.shellOwners";
import type * as Terminal from "../workspace/terminal";
import type * as TerminalStream from "../workspace/terminal.stream";
import type * as TerminalSearch from "../workspace/terminal.search";
import type * as TerminalPaste from "../workspace/terminal.paste";
import type * as TerminalRecovery from "../workspace/terminal.recovery";
import type * as TerminalActivity from "../workspace/terminal.activity";
import type * as TerminalLifecycle from "../workspace/terminal.lifecycle";
import type { TerminalWslDistributions } from "../workspace/terminal.wsl";
import type {
  TerminalShellProfileInventory,
  TerminalShellProfilesInput,
} from "../workspace/terminal.shellProfiles";

export interface TerminalNativeApi {
  remoteInventory?: (
    input: RemoteTerminal.TerminalRemoteInventoryInput,
  ) => Promise<RemoteTerminal.TerminalRemoteInventory>;
  remoteAttach?: (
    input: RemoteTerminal.TerminalRemoteAttachInput,
  ) => Promise<Terminal.TerminalSessionSnapshot>;
  remoteDetach?: (input: RemoteTerminal.TerminalRemoteDetachInput) => Promise<void>;
  remoteStop?: (input: RemoteTerminal.TerminalRemoteAttachInput) => Promise<void>;
  retainedShellOwners?: (
    input: ShellOwners.TerminalRetainedShellOwnersInput,
  ) => Promise<ShellOwners.TerminalRetainedShellOwners>;
  forgetRetainedShellOwners?: (
    input: ShellOwners.TerminalRetainedShellOwnersInput,
  ) => Promise<ShellOwners.TerminalForgetRetainedShellOwnersResult>;
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
    options?: {
      onInventory?: (inventory: TerminalStream.TerminalSessionInventory) => void;
      /** Opts in to terminal recency and finished-work items. */
      onWork?: (item: TerminalActivity.TerminalWorkActivity) => void;
      /** Opts in to lifecycle notices (idle warnings, closes, limit refusals). */
      onLifecycle?: (notice: TerminalLifecycle.TerminalLifecycleNotice) => void;
    },
  ) => () => void;
  /** Report the open thread and visible panes of this connection. */
  view?: (input: TerminalActivity.TerminalViewInput) => Promise<void>;
  /** One terminal's events for a mounted view, flow-controlled by `ackOutput`. */
  subscribeSession?: (
    input: TerminalStream.TerminalSessionStreamInput,
    callback: (item: TerminalStream.TerminalSessionStreamItem) => void,
    options?: {
      onError?: (error: unknown) => void;
      /** Opts in (`acceptScreen`) to the host screen sent first after `subscribed`. */
      onScreen?: (item: TerminalStream.TerminalScreenItem) => void;
    },
  ) => () => void;
  ackOutput?: (input: TerminalStream.TerminalOutputAckInput) => Promise<void>;
  /** Retained output of the server's terminals, newest lines first. */
  search?: (
    input: TerminalSearch.TerminalSearchInput,
  ) => Promise<TerminalSearch.TerminalSearchResult>;
  /** Stage a pasted/dropped file on the terminal's machine; resolves to its absolute path. */
  stagePasteFile?: (
    input: TerminalPaste.TerminalPasteStageInput,
  ) => Promise<TerminalPaste.TerminalPasteStageResult>;
  /** Restart one terminal's idle timer ("Keep open"). */
  keepOpen?: (input: TerminalLifecycle.TerminalKeepOpenInput) => Promise<void>;
  /** Run a setup script the live limit refused, closing `evict` first. */
  retrySetup?: (
    input: TerminalLifecycle.TerminalRetrySetupInput,
  ) => Promise<TerminalLifecycle.TerminalRetrySetupResult>;
}
