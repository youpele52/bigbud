import {
  sendWindowsControlRequest,
  WindowsControlUnavailableError,
} from "./remoteAgentLocalControl.windows.ts";
import { connect } from "node:net";
import { dirname, join } from "node:path";

import { readOwnershipLock, STATE_DIR_LOCK_FILENAME } from "@bigbud/shared/backendOwnership.record";
import { resolveDesktopReleaseIdentity } from "@bigbud/shared/desktopReleaseIdentity";
import { classifyStateDirLockOwner, defaultStateDirLockProbe } from "../startup/stateDirLock.ts";

import { ownershipStateDir, resolveOwnershipBaseDir } from "@bigbud/shared/backendOwnership.paths";

import {
  REMOTE_AGENT_CONTROL_MAX_REQUEST_BYTES,
  REMOTE_AGENT_CONTROL_MAX_WAIT_MS,
  REMOTE_AGENT_CONTROL_VERSION,
  remoteAgentControlSocketPath,
  type RemoteAgentControlRequest,
  type RemoteAgentControlResponse,
} from "./remoteAgentLocalControl.protocol.ts";
import {
  defaultRemoteAgentControlTransport,
  readRemoteAgentControlEndpoint,
  type RemoteAgentControlTransport,
} from "./remoteAgentLocalControl.endpoint.ts";

const BACKEND_NOT_RUNNING =
  "bigbud is not running. Start the bigbud app (or `bigbud` server), then retry.";

async function backendUnavailable(socketPath: string): Promise<RemoteAgentBackendUnavailableError> {
  // Windows lock ownership is not verified until native ACL enforcement is available.
  if (process.platform === "win32")
    return new RemoteAgentBackendUnavailableError(BACKEND_NOT_RUNNING);
  const owner = await readOwnershipLock(
    join(dirname(dirname(socketPath)), STATE_DIR_LOCK_FILENAME),
  ).catch(() => undefined);
  const live = owner && classifyStateDirLockOwner(owner, defaultStateDirLockProbe) === "live";
  return new RemoteAgentBackendUnavailableError(
    live
      ? "the bigbud backend is running but its command-line control channel is unavailable (see logs)"
      : BACKEND_NOT_RUNNING,
  );
}

/** Transport overrides exist for tests; production follows the platform default. */
export interface RemoteAgentControlClientOptions {
  readonly transport?: RemoteAgentControlTransport;
  readonly addressAllowed?: (address: string) => boolean;
}

/** The running backend is unreachable; the CLI never writes remote or local state itself. */
export class RemoteAgentBackendUnavailableError extends Error {
  readonly _tag = "RemoteAgentBackendUnavailableError";
}

export function resolveRemoteAgentControlSocket(input: {
  readonly baseDir?: string | undefined;
  readonly development: boolean;
  readonly version?: string;
  readonly environment?: NodeJS.ProcessEnv;
}): string {
  const environment = input.environment ?? process.env;
  const configured =
    input.baseDir ?? (environment.BIGBUD_HOME?.trim() || environment.T3CODE_HOME?.trim());
  const raw =
    configured ??
    (input.version && !input.development
      ? join(
          resolveOwnershipBaseDir(undefined),
          ...resolveDesktopReleaseIdentity(input.version).baseDirSuffix,
        )
      : undefined);
  return remoteAgentControlSocketPath(
    ownershipStateDir(resolveOwnershipBaseDir(raw), input.development),
  );
}

/** Send one request and read one newline-terminated response. */
export async function sendRemoteAgentControlRequest(
  socketPath: string,
  request: RemoteAgentControlRequest,
  timeoutMs: number,
  options: RemoteAgentControlClientOptions = {},
): Promise<RemoteAgentControlResponse> {
  if (process.platform === "win32") {
    try {
      return await sendWindowsControlRequest(socketPath, request, timeoutMs);
    } catch (cause) {
      if (cause instanceof WindowsControlUnavailableError)
        throw new RemoteAgentBackendUnavailableError(cause.message, { cause });
      throw cause; // Lost replies remain retryable under the original operation ID.
    }
  }
  let address = socketPath;
  let auth: string | undefined;
  if ((options.transport ?? defaultRemoteAgentControlTransport()) === "named-pipe") {
    const endpoint = await readRemoteAgentControlEndpoint(
      dirname(socketPath),
      options.addressAllowed,
    );
    if (!endpoint) throw await backendUnavailable(socketPath);
    address = endpoint.address;
    auth = endpoint.token;
  }
  const line = `${JSON.stringify({
    v: REMOTE_AGENT_CONTROL_VERSION,
    ...(auth ? { auth } : {}),
    ...request,
  })}\n`;
  if (Buffer.byteLength(line) > REMOTE_AGENT_CONTROL_MAX_REQUEST_BYTES) {
    throw new Error("Request is too large.");
  }
  return new Promise((resolve, reject) => {
    const socket = connect(address);
    let buffered = "";
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback();
    };
    const timer = setTimeout(
      () => settle(() => reject(new Error("The bigbud backend did not reply in time."))),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(line));
    socket.on("data", (chunk: string) => {
      if (Buffer.byteLength(buffered) + Buffer.byteLength(chunk) > 1024 * 1024) {
        settle(() => reject(new Error("The bigbud backend reply exceeds the control limit.")));
        return;
      }
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      settle(() => {
        try {
          resolve(JSON.parse(buffered.slice(0, newline)) as RemoteAgentControlResponse);
        } catch {
          reject(new Error("The bigbud backend returned an invalid reply."));
        }
      });
    });
    socket.on("error", (error: NodeJS.ErrnoException) =>
      settle(() => {
        if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
          void backendUnavailable(socketPath).then(reject, reject);
        } else reject(error);
      }),
    );
    socket.on("end", () =>
      settle(() => reject(new Error("The bigbud backend closed the connection."))),
    );
  });
}

/** Poll an accepted operation until it completes; lost replies are retried by operation ID. */
export async function waitForRemoteAgentOperation(
  socketPath: string,
  operationId: string,
  onProgress?: (response: RemoteAgentControlResponse) => void,
  options: RemoteAgentControlClientOptions = {},
): Promise<RemoteAgentControlResponse> {
  let failures = 0;
  for (;;) {
    try {
      const response = await sendRemoteAgentControlRequest(
        socketPath,
        { method: "operation", operationId, waitMs: REMOTE_AGENT_CONTROL_MAX_WAIT_MS },
        REMOTE_AGENT_CONTROL_MAX_WAIT_MS + 10_000,
        options,
      );
      failures = 0;
      onProgress?.(response);
      if (!response.ok) return response;
      if ((response.result as { state?: unknown }).state === "completed") return response;
    } catch (cause) {
      // A lost reply is not cancellation: re-read the same operation instead of re-installing.
      failures += 1;
      if (cause instanceof RemoteAgentBackendUnavailableError || failures >= 5) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 1_000 * failures));
    }
  }
}
