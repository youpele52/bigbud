import { join } from "node:path";
import { REMOTE_BACKEND_MAX_CLIENT_TOKEN_BYTES } from "../remote-backend/clientAuthorization.ts";

export class RemoteProfileConfigurationError extends Error {
  readonly _tag = "RemoteProfileConfigurationError";
}

export interface RemoteStartupOptions {
  readonly mode: string;
  readonly authToken: string | undefined;
  readonly devUrl: URL | undefined;
  readonly host: string | undefined;
  readonly bootstrapRequested: boolean;
}

/** Validate before creating directories, reading desktop descriptors, or installing native hooks. */
export function assertRemoteStartupOptions(
  options: RemoteStartupOptions,
  platform: NodeJS.Platform = process.platform,
): void {
  if (options.mode !== "remote") return;
  if (
    !options.authToken ||
    /\s/.test(options.authToken) ||
    Buffer.byteLength(options.authToken) > REMOTE_BACKEND_MAX_CLIENT_TOKEN_BYTES
  ) {
    throw new RemoteProfileConfigurationError(
      "Remote mode requires an explicit client authentication token without whitespace.",
    );
  }
  if (platform !== "linux") {
    throw new RemoteProfileConfigurationError("Remote backend mode supports Linux hosts only.");
  }
  if (options.bootstrapRequested) {
    throw new RemoteProfileConfigurationError(
      "Remote mode cannot use the desktop bootstrap or lifecycle descriptors.",
    );
  }
  if (options.devUrl !== undefined) {
    throw new RemoteProfileConfigurationError("Remote mode cannot proxy to a development server.");
  }
  if (options.host !== undefined && options.host !== "127.0.0.1") {
    throw new RemoteProfileConfigurationError(
      "Remote clients use a private Unix socket; callback TCP must stay on 127.0.0.1.",
    );
  }
}

export function remoteClientSocketPath(stateDir: string): string {
  const path = join(stateDir, "remote-backend.sock");
  // Linux sockaddr_un has 108 bytes including its terminating NUL.
  if (Buffer.byteLength(path) >= 108) {
    throw new RemoteProfileConfigurationError(
      "The remote state-directory path is too long for a Unix socket. Choose a shorter state root.",
    );
  }
  return path;
}

/** Defend direct embedding callers as well as the CLI's normalized remote configuration. */
export function assertRemoteServerProfile(
  config: Omit<RemoteStartupOptions, "bootstrapRequested"> & {
    readonly desktopStartReason?: string | undefined;
    readonly desktopLifecycleHintFd?: number | undefined;
    readonly desktopOwnershipHandoff?: boolean | undefined;
    readonly noBrowser: boolean;
    readonly autoBootstrapProjectFromCwd: boolean;
  },
  platform: NodeJS.Platform = process.platform,
): void {
  assertRemoteStartupOptions(
    {
      ...config,
      bootstrapRequested:
        config.desktopStartReason !== undefined ||
        config.desktopLifecycleHintFd !== undefined ||
        config.desktopOwnershipHandoff !== undefined,
    },
    platform,
  );
  if (config.mode === "remote" && (!config.noBrowser || config.autoBootstrapProjectFromCwd))
    throw new RemoteProfileConfigurationError(
      "Remote mode must disable browser launch and automatic workspace bootstrap.",
    );
}
