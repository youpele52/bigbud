import { readNativeApi } from "../rpc/nativeApi";
import { getSshHostTrustChallenge, type SshAuthMode } from "./ssh";

/** Shared by project setup, folder browsing and reconnect authentication. */
export async function submitSshAuthentication(input: {
  executionTargetId: string;
  mode: SshAuthMode;
  promptLabel: string;
  secret: string;
}): Promise<void> {
  const api = readNativeApi();
  if (!api) throw new Error("Native API not found.");
  const { executionTargetId, mode, secret } = input;
  if (mode === "host-trust") {
    const challenge = getSshHostTrustChallenge(input.promptLabel);
    if (!challenge) throw new Error("SSH host confirmation was lost. Retry the connection.");
    await api.server.trustSshHost({ executionTargetId, challengeId: challenge.challengeId });
  } else if (mode === "password") {
    await api.server.unlockSshPassword({ executionTargetId, password: secret });
  } else {
    await api.server.unlockSshKey({ executionTargetId, passphrase: secret });
  }
}
