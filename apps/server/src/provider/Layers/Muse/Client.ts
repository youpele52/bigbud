/**
 * Injected Muse MSP transport seam. The production implementation wraps the
 * official low-level SDK connection (facade `startSession` cannot carry
 * per-session MCP config); tests substitute a deterministic fake transport.
 */
export interface MuseNotification {
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface MuseServerRequest {
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface MuseInitializeResult {
  readonly grantedCapabilities: ReadonlyArray<string>;
  readonly sessionDurability?: string;
  readonly serverVersion?: string;
  readonly schemaFingerprint?: string;
  readonly fingerprintWarning?: string;
  readonly sandboxAvailability?: string;
  /** Native reason when the sandbox is unavailable (e.g. Linux `bubblewrapUnavailable`). */
  readonly sandboxUnavailableReason?: string;
  /** Native home path used only as a session storage identity; never logged or sent to clients. */
  readonly museHome?: string;
}

export interface MuseTransport {
  readonly initializeResult: MuseInitializeResult;
  readonly mintCommandId: () => string;
  readonly command: (
    method: string,
    params: Record<string, unknown>,
    commandId: string,
  ) => Promise<Record<string, unknown>>;
  readonly request: (
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  readonly onNotification: (handler: (notification: MuseNotification) => void) => void;
  readonly onServerRequest: (
    handler: (request: MuseServerRequest) => Promise<Record<string, unknown>>,
  ) => void;
  readonly close: () => Promise<void>;
  /** Optional fake-compatible lifecycle seam; callback is invoked at most once for unexpected loss. */
  readonly onExit?: (handler: (cause: unknown) => void) => void;
}

export interface MuseHostOptions {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly onExit?: (cause: unknown) => void;
  readonly onNotification?: (notification: MuseNotification) => void;
  readonly onServerRequest?: (request: MuseServerRequest) => Promise<Record<string, unknown>>;
}

export type MuseHostFactory = (options: MuseHostOptions) => Promise<MuseTransport>;

/** Capabilities bigbud requests deliberately; grants are validated, never assumed. */
export const MUSE_REQUESTED_CAPABILITIES = ["sessionMcp"] as const;

export function assertMuseHostQualified(transport: MuseTransport): string | undefined {
  if (!transport.initializeResult.grantedCapabilities.includes("sessionMcp")) {
    return "Muse host did not grant the sessionMcp capability required for bigbud thread tools.";
  }
  if (transport.initializeResult.sessionDurability !== "durable") {
    return "Muse host did not report durable session storage; ephemeral sessions are not supported.";
  }
  // The only supported access mode promises workspace edits *inside the
  // native sandbox* (out-of-workspace writes denied). Without a sandbox that
  // promise is false, so refuse rather than run unsandboxed. Absent means an
  // older host that predates the field; it is not treated as unavailable.
  if (transport.initializeResult.sandboxAvailability === "unavailable") {
    return museSandboxUnavailableMessage(transport.initializeResult.sandboxUnavailableReason);
  }
  return undefined;
}

export function museSandboxUnavailableMessage(
  reason: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  const remedy =
    reason === "bubblewrapUnavailable"
      ? "Install bubblewrap (`bwrap`) with your package manager"
      : reason === "userNamespacesDenied"
        ? "Allow unprivileged user namespaces (for example the kernel.apparmor_restrict_unprivileged_userns or user.max_user_namespaces setting)"
        : platform === "win32"
          ? "Run `muse sandbox windows setup` in a terminal (Windows may ask for administrator approval once)"
          : "Run `muse` once in a terminal to see the sandbox error";
  return `Muse cannot enforce its OS sandbox on this machine${reason ? ` (${reason})` : ""}, so bigbud will not run it. ${remedy}, then restart bigbud.`;
}
