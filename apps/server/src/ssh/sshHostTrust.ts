import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ServerTrustSshHostInput,
  SshHostTrustChallenge,
} from "@bigbud/contracts/server/server.sshHostTrust";

import { formatSshDestination, parseSshExecutionTarget } from "./sshExecutionTarget.ts";
import { describeSshLocalCommandFailure, runSshLocalCommand } from "./sshLocalCommand.ts";

const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_CHALLENGES = 128;
const challenges = new Map<
  string,
  {
    target: string;
    prompt: string;
    expiresAt: number;
  }
>();

function createChallenge(target: string, prompt: string): never {
  const fingerprint = /^(\S+) key fingerprint is:? (SHA256:[A-Za-z0-9+/=]+)\.?\r?$/m.exec(prompt);
  const host = /authenticity of host '([^'\n]+)'/.exec(prompt)?.[1];
  if (!fingerprint || !host) {
    throw new Error("SSH requested an unsupported confirmation. No host was trusted.");
  }
  for (const [id, challenge] of challenges) {
    if (challenge.expiresAt <= Date.now()) challenges.delete(id);
  }
  if (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value!);
  const challengeId = randomUUID();
  challenges.set(challengeId, { target, prompt, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  const challenge: SshHostTrustChallenge = {
    challengeId,
    host,
    keyType: fingerprint[1]!,
    fingerprint: fingerprint[2]!,
  };
  throw new Error(`SSH host trust is required: ${JSON.stringify(challenge)}`);
}

/** Lets OpenSSH verify configured known-hosts files, aliases and proxies without sending credentials. */
export async function inspectSshHostTrust(
  targetId: string,
  approvedPrompt?: string,
): Promise<void> {
  const target = parseSshExecutionTarget(targetId);
  if (!target) throw new Error(`Invalid SSH execution target '${targetId}'.`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bigbud-ssh-trust-"));
  const promptPath = path.join(directory, "prompt");
  const scriptPath = path.join(directory, "askpass.sh");
  try {
    // Only the exact previously displayed prompt can receive approval. Never answer auth prompts.
    fs.writeFileSync(
      scriptPath,
      [
        "#!/bin/sh",
        'printf "%s" "$1" > "$BIGBUD_SSH_TRUST_PROMPT_FILE"',
        'if [ -n "$BIGBUD_SSH_APPROVED_PROMPT" ] && [ "$1" = "$BIGBUD_SSH_APPROVED_PROMPT" ]; then',
        '  printf "yes\\n"',
        "else exit 1; fi",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    const result = await runSshLocalCommand(
      "ssh",
      [
        "-T",
        "-o",
        "BatchMode=no",
        "-o",
        "StrictHostKeyChecking=ask",
        "-o",
        "FingerprintHash=sha256",
        "-o",
        "UpdateHostKeys=no",
        "-o",
        "ControlPath=none",
        "-o",
        "PreferredAuthentications=none",
        "-o",
        "PubkeyAuthentication=no",
        "-o",
        "PasswordAuthentication=no",
        "-o",
        "KbdInteractiveAuthentication=no",
        "-o",
        "NumberOfPasswordPrompts=0",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ConnectionAttempts=1",
        ...(target.port ? ["-p", target.port] : []),
        formatSshDestination(target),
        "true",
      ],
      {
        timeoutMs: 12_000,
        env: {
          ...process.env,
          LC_ALL: "C",
          SSH_ASKPASS: scriptPath,
          SSH_ASKPASS_REQUIRE: "force",
          DISPLAY: process.env.DISPLAY || "bigbud:0",
          BIGBUD_SSH_TRUST_PROMPT_FILE: promptPath,
          BIGBUD_SSH_APPROVED_PROMPT: approvedPrompt ?? "",
        },
      },
    );
    const prompt = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, "utf8") : "";
    if (
      /REMOTE HOST IDENTIFICATION HAS CHANGED|REVOKED HOST KEY|Offending .* key/i.test(
        result.stderr,
      )
    ) {
      throw new Error(
        "The SSH server's identity has changed or was revoked. Connection blocked. Verify the server with your administrator before updating known_hosts.",
      );
    }
    if (prompt && prompt !== approvedPrompt) createChallenge(targetId, prompt);
    if (/Failed to add the host|Could not create directory/i.test(result.stderr)) {
      throw new Error(
        `SSH could not save the trusted server in known_hosts. ${result.stderr.trim()}`,
      );
    }
    // Authentication denial is expected: this probe deliberately offers no credentials.
    if (
      !result.timedOut &&
      !result.error &&
      (result.status === 0 || /Permission denied/i.test(result.stderr))
    )
      return;
    throw new Error(
      `Failed to verify the SSH server identity. ${describeSshLocalCommandFailure(result)}`,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** Rechecks the exact approved host key; OpenSSH persists it using the user's normal SSH config. */
export async function trustSshHost(input: ServerTrustSshHostInput): Promise<{ message: string }> {
  const challenge = challenges.get(input.challengeId);
  if (
    !challenge ||
    challenge.target !== input.executionTargetId ||
    challenge.expiresAt <= Date.now()
  ) {
    throw new Error(
      "SSH host confirmation expired. Retry the connection to review its fingerprint again.",
    );
  }
  challenges.delete(input.challengeId);
  await inspectSshHostTrust(input.executionTargetId, challenge.prompt);
  return { message: "SSH server identity trusted. Continue connecting." };
}

/** Only probes after host/auth setup failures, keeping established connections on their fast path. */
export async function inspectSshHostTrustOnFailure(
  targetId: string,
  error: unknown,
): Promise<never> {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /host key verification failed|SSH password is required|SSH key '.+' requires a passphrase/i.test(
      message,
    )
  ) {
    await inspectSshHostTrust(targetId);
  }
  throw error;
}
