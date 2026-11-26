import { describe, expect, it, vi } from "vitest";

import { credentialPromptFor } from "./sshOwnerPickerProof.client.credentialPrompt.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";
import { SshTargetAuthRequiredError } from "./sshTargetUnavailable.ts";

const state = (value: object) => async () => ({ kind: "credentialState", value }) as never;
const shell = { kind: "credentialLock" } as const;

describe("credential prompt for any bound-target verb", () => {
  it("turns credentialRequired into the typed password prompt", async () => {
    const error = await credentialPromptFor(
      new PickerProofOwnerError("credentialRequired"),
      shell,
      "ssh:host=h&auth=password",
      state({ credential: "password", unlocked: false, attemptsRemaining: 3 }),
    );
    expect(error).toBeInstanceOf(SshTargetAuthRequiredError);
    expect((error as SshTargetAuthRequiredError).message).toMatch(
      /^SSH password is required for ssh:host=h&auth=password\./u,
    );
  });

  it("names the encrypted identity for a passphrase and keeps other errors", async () => {
    const passphrase = await credentialPromptFor(
      new PickerProofOwnerError("credentialRequired"),
      shell,
      "box",
      state({ credential: "keyPassphrase", unlocked: false, attemptsRemaining: 3, identity: "/k" }),
    );
    expect((passphrase as SshTargetAuthRequiredError).authMode).toBe("ssh-key-passphrase");
    expect((passphrase as SshTargetAuthRequiredError).executionTargetId).toBe("ssh:box");
    const other = new PickerProofOwnerError("transportLost");
    const inspect = vi.fn();
    expect(await credentialPromptFor(other, shell, "box", inspect)).toBe(other);
    expect(inspect).not.toHaveBeenCalled();
  });
});
