/**
 * Owned `muse serve` host lifecycle over the official SDK.
 *
 * Adapted from the proven upstream host pattern to bigbud shape: handshake
 * deadline with close-before-initialize-reply, abort-settles-startup,
 * fingerprint mismatch warns only, bounded stderr tail, platform launch
 * resolution (Client.platform.ts), and MUSE_NO_AUTO_UPDATE=1.
 * One owned child per active thread; never attaches to a user TUI.
 */
import { spawnMspConnection } from "@muse-code/sdk";

import type { MuseHostFactory, MuseTransport } from "./Client.ts";
import { resolveMuseLaunch } from "./Client.platform.ts";

export const MUSE_HANDSHAKE_TIMEOUT_MS = 20_000;
/**
 * How long `close()` lets the host drain after stdin EOF before the SDK sends
 * SIGTERM (then SIGKILL 2 s later). The SDK default is the host's own 30 s
 * drain window; 20 s keeps session stop responsive (user decision 2026-10-29;
 * upstream t3code uses 10 s). Past it, native shutdown has crash semantics,
 * which session resume already tolerates.
 */
export const MUSE_SHUTDOWN_TIMEOUT_MS = 20_000;
/**
 * `--trust-workspace`: the host loads each session workspace's own skills and
 * rules (user decision 2026-10-29, matching upstream t3code). Sandbox,
 * permission profile and approval mode are unaffected.
 */
export const MUSE_SERVE_FLAGS = ["--trust-workspace"] as const;
const STDERR_TAIL_LIMIT = 4_000;

export const makeSdkMuseHostFactory =
  (timeoutMs = MUSE_HANDSHAKE_TIMEOUT_MS): MuseHostFactory =>
  async (options) => {
    if (options.signal?.aborted) throw new Error("Muse startup aborted before spawn.");
    let stderrTail = "";
    let intentionalClose = false;
    let exitCause: unknown;
    let exitHandler: ((cause: unknown) => void) | undefined;
    const notifyExit = (cause: unknown) => {
      if (intentionalClose || exitCause !== undefined) return;
      exitCause = cause;
      options.onExit?.(cause);
      exitHandler?.(cause);
    };
    const launch = resolveMuseLaunch(options.binaryPath);
    const handshake = spawnMspConnection({
      command: launch.command,
      args: [...launch.args, ...MUSE_SERVE_FLAGS],
      cwd: options.cwd,
      env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" },
      shutdownTimeoutMs: MUSE_SHUTDOWN_TIMEOUT_MS,
      onStderr: (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      },
    });
    handshake.onProtocolError((cause) => notifyExit(cause));
    void handshake.exited.then(
      (exit) =>
        notifyExit({ detail: `Muse host exited (code ${exit.code}, signal ${exit.signal}).` }),
      notifyExit,
    );
    if (options.onNotification) handshake.onNotification(options.onNotification);
    if (options.onServerRequest) {
      handshake.onServerRequest(async (request) =>
        options.onServerRequest!({
          method: request.method,
          ...(request.params ? { params: request.params } : {}),
        }),
      );
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;
    try {
      const spawned = await Promise.race([
        handshake.initialize({
          clientInfo: { name: "bigbud", version: "0.0.1" },
          capabilities: {
            experimentalApi: true,
            requestedCapabilities: ["sessionMcp"],
            userInputDialogs: true,
          },
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Muse handshake timed out after ${timeoutMs}ms.`)),
            timeoutMs,
          );
        }),
        new Promise<never>((_, reject) => {
          abortHandler = () => {
            intentionalClose = true;
            void handshake.close().catch(() => undefined);
            reject(new Error("Muse startup aborted."));
          };
          options.signal?.addEventListener("abort", abortHandler, { once: true });
          if (options.signal?.aborted) abortHandler();
        }),
      ]);
      void spawned.connection.closed.then(
        () => notifyExit({ detail: "Muse connection closed unexpectedly." }),
        notifyExit,
      );
      if (exitCause !== undefined)
        throw new Error("Muse host lost during initialization.", { cause: exitCause });
      const result = spawned.initializeResult;
      const transport: MuseTransport = {
        initializeResult: {
          grantedCapabilities: result.grantedCapabilities,
          ...(result.sessionDurability ? { sessionDurability: result.sessionDurability } : {}),
          ...(result.serverInfo?.version ? { serverVersion: result.serverInfo.version } : {}),
          ...(result.schema?.fingerprint ? { schemaFingerprint: result.schema.fingerprint } : {}),
          ...(spawned.fingerprintWarning
            ? { fingerprintWarning: spawned.fingerprintWarning.message }
            : {}),
          ...(result.sandboxAvailability
            ? { sandboxAvailability: result.sandboxAvailability }
            : {}),
          ...(result.sandboxUnavailableReason
            ? { sandboxUnavailableReason: result.sandboxUnavailableReason }
            : {}),
          ...(result.museHome ? { museHome: result.museHome } : {}),
        },
        mintCommandId: () => spawned.connection.mintCommandId(),
        command: (method, params, commandId) =>
          spawned.connection.command(method, params, { commandId, maxAttempts: 1 }),
        request: (method, params) => spawned.connection.request(method, params),
        onNotification: (handler) => spawned.connection.onNotification(handler),
        onServerRequest: (handler) =>
          spawned.connection.onServerRequest(async (request) =>
            handler({
              method: request.method,
              ...(request.params ? { params: request.params } : {}),
            }),
          ),
        close: async () => {
          intentionalClose = true;
          await spawned.close();
        },
        onExit: (handler) => {
          exitHandler = handler;
          if (exitCause !== undefined) handler(exitCause);
        },
      };
      return transport;
    } catch (error) {
      intentionalClose = true;
      // Close the child even when initialize never replies, so a failed
      // handshake cannot leak a `muse serve` process.
      await handshake.close().catch(() => undefined);
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(stderrTail ? `${detail} (stderr tail: ${stderrTail.slice(-300)})` : detail, {
        cause: error,
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
    }
  };
