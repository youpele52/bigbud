import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SshHostTrustChallenge } from "@bigbud/contracts/server/server.sshHostTrust";
import { inspectSshHostTrust, inspectSshHostTrustOnFailure, trustSshHost } from "./sshHostTrust.ts";
import { runSshLocalCommand, type SshLocalCommandResult } from "./sshLocalCommand.ts";

vi.mock("./sshLocalCommand.ts", async (original) => ({
  ...(await original<typeof import("./sshLocalCommand.ts")>()),
  runSshLocalCommand: vi.fn(),
}));
const run = vi.mocked(runSshLocalCommand);
const target = "ssh:host=box&user=alice&port=2222&auth=password";
const prompt =
  "The authenticity of host '[box]:2222 ([192.0.2.1]:2222)' can't be established.\nED25519 key fingerprint is SHA256:abc123.\nAre you sure you want to continue connecting (yes/no/[fingerprint])?";
const denied: SshLocalCommandResult = {
  status: 255,
  stdout: "",
  stderr: "alice@box: Permission denied (publickey,password).",
  timedOut: false,
};

function unknownHost(text = prompt) {
  run.mockImplementationOnce(async (_command, _args, options) => {
    fs.writeFileSync(options.env!.BIGBUD_SSH_TRUST_PROMPT_FILE!, text);
    return { ...denied, stderr: "Host key verification failed." };
  });
}

async function challenge(): Promise<SshHostTrustChallenge> {
  unknownHost();
  try {
    await inspectSshHostTrust(target);
  } catch (error) {
    return JSON.parse((error as Error).message.replace("SSH host trust is required: ", ""));
  }
  throw new Error("Expected a trust challenge.");
}

describe("SSH host trust", () => {
  beforeEach(() => {
    run.mockReset();
    run.mockResolvedValue(denied);
  });
  afterEach(() => vi.restoreAllMocks());

  it("reports an unknown host fingerprint without accepting it or supplying credentials", async () => {
    const result = await challenge();
    expect(result).toMatchObject({
      host: "[box]:2222 ([192.0.2.1]:2222)",
      keyType: "ED25519",
      fingerprint: "SHA256:abc123",
    });
    const [, args, options] = run.mock.calls[0]!;
    expect(args).toContain("PreferredAuthentications=none");
    expect(args).toContain("StrictHostKeyChecking=ask");
    expect(args).toContain("ControlPath=none");
    expect(args).toContain("2222");
    expect(options.env!.BIGBUD_SSH_APPROVED_PROMPT).toBe("");
    expect(fs.existsSync(options.env!.BIGBUD_SSH_TRUST_PROMPT_FILE!)).toBe(false);
  });

  it("accepts already-trusted hosts without creating a challenge", async () => {
    await expect(inspectSshHostTrust(target)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "only answers yes to the exact approved fingerprint prompt",
    async () => {
      const pending = await challenge();
      run.mockImplementationOnce(async (_command, _args, options) => {
        const script = options.env!.SSH_ASKPASS!;
        const execute = (text: string) =>
          spawnSync(script, [text], { env: options.env, encoding: "utf8" });
        expect(execute("alice@box's password:").status).toBe(1);
        expect(execute(prompt.replace("abc123", "different")).status).toBe(1);
        const approved = execute(prompt);
        expect(approved.status).toBe(0);
        expect(approved.stdout).toBe("yes\n");
        return denied;
      });
      await expect(
        trustSshHost({ executionTargetId: target, challengeId: pending.challengeId }),
      ).resolves.toHaveProperty("message");
      await expect(
        trustSshHost({ executionTargetId: target, challengeId: pending.challengeId }),
      ).rejects.toThrow(/expired/);
    },
  );

  it("does not trust a different key presented after approval", async () => {
    const pending = await challenge();
    unknownHost(prompt.replace("abc123", "different"));
    await expect(
      trustSshHost({ executionTargetId: target, challengeId: pending.challengeId }),
    ).rejects.toThrow(/SHA256:different/);
  });

  it("binds approval to the execution target", async () => {
    const pending = await challenge();
    await expect(
      trustSshHost({ executionTargetId: "ssh:other", challengeId: pending.challengeId }),
    ).rejects.toThrow(/expired/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("expires pending approval", async () => {
    const pending = await challenge();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60_000);
    await expect(
      trustSshHost({ executionTargetId: target, challengeId: pending.challengeId }),
    ).rejects.toThrow(/expired/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    "REMOTE HOST IDENTIFICATION HAS CHANGED",
    "REVOKED HOST KEY",
    "Offending ED25519 key in known_hosts:1",
  ])("blocks unsafe host identities: %s", async (stderr) => {
    run.mockResolvedValueOnce({ ...denied, stderr });
    await expect(inspectSshHostTrust(target)).rejects.toThrow(
      /identity has changed or was revoked/,
    );
  });

  it("reports known_hosts persistence failures instead of claiming trust was saved", async () => {
    run.mockResolvedValueOnce({
      ...denied,
      stderr: "Failed to add the host to the list of known hosts.\nPermission denied (publickey).",
    });
    await expect(inspectSshHostTrust(target)).rejects.toThrow(/could not save/);
  });

  it("reports timeouts and unexpected prompts without trusting them", async () => {
    run.mockResolvedValueOnce({ ...denied, timedOut: true, error: new Error("deadline exceeded") });
    await expect(inspectSshHostTrust(target)).rejects.toThrow(/deadline exceeded/);
    unknownHost("Enter a verification code:");
    await expect(inspectSshHostTrust(target)).rejects.toThrow(/unsupported confirmation/);
  });

  it("supports the OpenSSH fingerprint prompt with a colon after is", async () => {
    unknownHost(prompt.replace("fingerprint is ", "fingerprint is: ").replace("abc123.", "abc123"));
    await expect(inspectSshHostTrust(target)).rejects.toThrow(/SHA256:abc123/);
  });

  it("only performs fallback identity checks for relevant setup failures", async () => {
    const failure = new Error("Remote folder does not exist.");
    await expect(inspectSshHostTrustOnFailure(target, failure)).rejects.toBe(failure);
    expect(run).not.toHaveBeenCalled();
    unknownHost();
    await expect(
      inspectSshHostTrustOnFailure(target, new Error("Host key verification failed.")),
    ).rejects.toThrow(/SSH host trust is required/);
  });
});
