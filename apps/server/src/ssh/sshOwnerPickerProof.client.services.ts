import { isAbsolute } from "node:path";

import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

/**
 * The product provider services are Linux-only and require the authorized
 * workspace root. The executable is the configured remote one; a request can
 * never substitute a different program, arguments or forward.
 */
export function validateProviderServiceStartup(
  services: ReadonlyArray<{ readonly binaryPath: string } | undefined>,
  workspaceRoot: string | undefined,
): void {
  for (const service of services) {
    if (
      service !== undefined &&
      (process.platform !== "linux" ||
        workspaceRoot === undefined ||
        !isAbsolute(service.binaryPath) ||
        service.binaryPath.includes("\0"))
    ) {
      throw new PickerProofOwnerError("invalidOperands");
    }
  }
}

/**
 * The OpenCode v2 lane runs on macOS and Linux initiating hosts (the remote
 * must be Linux; the owner's remote guard checks it). A fixture owner pins its
 * workspace root; a production owner takes each request's absolute cwd.
 */
export function validateOpencodeV2ServiceStartup(
  service: { readonly binaryPath?: string } | undefined,
  workspaceRoot: string | undefined,
  production: boolean,
): void {
  // An absent `binaryPath` asks the owner to discover the executable remotely.
  const binary = service?.binaryPath;
  if (
    service !== undefined &&
    ((process.platform !== "linux" && process.platform !== "darwin") ||
      (!production && workspaceRoot === undefined) ||
      (binary !== undefined && (!isAbsolute(binary) || binary.includes("\0"))))
  ) {
    throw new PickerProofOwnerError("invalidOperands");
  }
}
