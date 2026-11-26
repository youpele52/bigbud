import type { PickerProofOperation } from "./sshOwnerPickerProof.codec.ts";
import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";
import { buildSshKeyPassphraseRequiredMessage } from "./sshOwnerProductionCredential.prompt.ts";
import {
  buildSshPasswordRequiredMessage,
  SshTargetAuthRequiredError,
} from "./sshTargetUnavailable.ts";

/**
 * Turns an owner `credentialRequired` refusal on any bound-target verb (picker, provider,
 * terminal, Git, workspace, shell) into the typed prompt error the web client already parses,
 * so every path opens the same in-app password or passphrase dialog and retries its action.
 * The credential kind comes from one `inspectCredential` on the same target; any other error
 * passes through unchanged.
 *
 * @module sshOwnerPickerProof.client.credentialPrompt
 */
export async function credentialPromptFor(
  error: unknown,
  operation: PickerProofOperation,
  targetId: string,
  inspect: (operation: PickerProofOperation) => Promise<Outcome>,
): Promise<unknown> {
  if (
    !(error instanceof PickerProofOwnerError) ||
    error.code !== "credentialRequired" ||
    operation.kind === "inspectCredential"
  )
    return error;
  const outcome = await inspect({ kind: "inspectCredential" }).catch(() => undefined);
  const state = outcome?.kind === "credentialState" ? outcome.value : undefined;
  const runtimeId = targetId.startsWith("ssh:") ? targetId : `ssh:${targetId}`;
  if (state?.credential === "password")
    return new SshTargetAuthRequiredError(
      runtimeId,
      "password",
      buildSshPasswordRequiredMessage(runtimeId),
    );
  if (state?.credential === "keyPassphrase" && state.identity)
    return new SshTargetAuthRequiredError(
      runtimeId,
      "ssh-key-passphrase",
      buildSshKeyPassphraseRequiredMessage(state.identity),
    );
  return error;
}
