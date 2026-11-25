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
