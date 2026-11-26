import {
  PickerProofStartupConfigError,
  PickerProofStartupRetirementError,
  PickerProofStartupTimeoutError,
  type PickerProofStartupConfigDiagnostic,
} from "./sshOwnerPickerProof.startupDiagnostic.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.ts";

/**
 * Throws the typed startup failure for a failed proof handshake. Production
 * launch uses the deadline and never masks a protocol failure with a timeout.
 *
 * @module sshOwnerPickerProof.client.startupError
 */

interface StartupErrorPipe {
  startupTimedOut(): boolean;
  startupRetirementDiagnostic(): string | undefined;
  startupConfigDiagnostic(): PickerProofStartupConfigDiagnostic | undefined;
}

export function throwPickerProofStartupError(
  error: unknown,
  pipe: StartupErrorPipe,
  productionDeadlineMs?: number,
): never {
  if (pipe.startupTimedOut() && productionDeadlineMs !== undefined) {
    throw new PickerProofStartupTimeoutError(productionDeadlineMs);
  }
  const retirement = pipe.startupRetirementDiagnostic();
  if (retirement && error instanceof PickerProofOwnerError && error.code === "ownerUnavailable") {
    throw new PickerProofStartupRetirementError(retirement);
  }
  const diagnostic = pipe.startupConfigDiagnostic();
  if (diagnostic && error instanceof PickerProofOwnerError && error.code === "ownerUnavailable") {
    throw new PickerProofStartupConfigError(diagnostic);
  }
  throw error;
}
