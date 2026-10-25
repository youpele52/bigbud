/**
 * ssh-agent discovery and key-loaded probes. Unlock flows use the async
 * variants under one overall deadline; the synchronous readiness check keeps
 * a bounded synchronous probe because its callers are synchronous.
 *
 * @module sshAgent
 */
import fs from "node:fs";

import {
  assertSshLocalCommandFinished,
  describeSshLocalCommandFailure,
  runSshLocalCommand,
  runSshLocalCommandSync,
  type SshDeadline,
  SSH_LOCAL_PROBE_TIMEOUT_MS,
  type SshLocalCommandResult,
} from "./sshLocalCommand.ts";

const SSH_AGENT_ENV_PATTERN = /^(SSH_AUTH_SOCK|SSH_AGENT_PID)=([^;]+);/gm;

function createSshAgentEnvFromOutput(stdout: string): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = {};
  for (const match of stdout.matchAll(SSH_AGENT_ENV_PATTERN)) {
    const [, key, value] = match;
    if (key && value) {
      nextEnv[key] = value;
    }
  }
  return nextEnv;
}

function isUsableAgentProbe(probe: SshLocalCommandResult): boolean {
  const detail = probe.stderr.trim();
  return (
    probe.status === 0 ||
    /the agent has no identities/i.test(detail) ||
    /error fetching identities for protocol 1/i.test(detail)
  );
}

/** Reuses a responsive agent from the environment, or starts one and exports its socket. */
export async function ensureSshAgentEnv(deadline: SshDeadline): Promise<NodeJS.ProcessEnv> {
  const existingSocket = process.env.SSH_AUTH_SOCK?.trim();
  if (existingSocket) {
    const probe = await runSshLocalCommand("ssh-add", ["-l"], {
      env: process.env,
      timeoutMs: deadline.remainingMs(SSH_LOCAL_PROBE_TIMEOUT_MS),
    });
    if (isUsableAgentProbe(probe)) {
      return process.env;
    }
  }

  const result = await runSshLocalCommand("ssh-agent", ["-s"], {
    timeoutMs: deadline.remainingMs(SSH_LOCAL_PROBE_TIMEOUT_MS),
  });
  assertSshLocalCommandFinished(result, "starting ssh-agent");
  if (result.error || result.status !== 0) {
    throw new Error(`Failed to start ssh-agent. ${describeSshLocalCommandFailure(result)}`);
  }

  const nextEnv = createSshAgentEnvFromOutput(result.stdout);
  const nextSocket = nextEnv.SSH_AUTH_SOCK?.trim();
  if (!nextSocket) {
    throw new Error("Failed to start ssh-agent. Missing SSH_AUTH_SOCK.");
  }

  process.env.SSH_AUTH_SOCK = nextSocket;
  if (nextEnv.SSH_AGENT_PID) {
    process.env.SSH_AGENT_PID = nextEnv.SSH_AGENT_PID;
  }

  return process.env;
}

function readPublicKey(publicKeyPath: string): string {
  return fs.readFileSync(publicKeyPath, "utf8").trim();
}

function isKeyListed(listedKeys: SshLocalCommandResult, publicKeyPath: string): boolean {
  if (listedKeys.status !== 0) return false;
  const publicKey = readPublicKey(publicKeyPath);
  return publicKey.length > 0 && listedKeys.stdout.includes(publicKey);
}

/** Synchronous probe for the synchronous readiness check; each command is time-bounded. */
export function isPassphraseProtectedKeyLoaded(expandedKeyPath: string): boolean {
  const publicKeyPath = `${expandedKeyPath}.pub`;
  if (!fs.existsSync(publicKeyPath)) {
    return false;
  }
  const options = { env: process.env, timeoutMs: SSH_LOCAL_PROBE_TIMEOUT_MS };
  if (runSshLocalCommandSync("ssh-add", ["-T", publicKeyPath], options).status === 0) {
    return true;
  }
  return isKeyListed(runSshLocalCommandSync("ssh-add", ["-L"], options), publicKeyPath);
}

export async function isPassphraseProtectedKeyLoadedAsync(
  expandedKeyPath: string,
  deadline: SshDeadline,
): Promise<boolean> {
  const publicKeyPath = `${expandedKeyPath}.pub`;
  if (!fs.existsSync(publicKeyPath)) {
    return false;
  }
  const options = () => ({
    env: process.env,
    timeoutMs: deadline.remainingMs(SSH_LOCAL_PROBE_TIMEOUT_MS),
  });
  const directProbe = await runSshLocalCommand("ssh-add", ["-T", publicKeyPath], options());
  assertSshLocalCommandFinished(directProbe, "waiting for ssh-agent to confirm the key");
  if (directProbe.status === 0) {
    return true;
  }
  const listedKeys = await runSshLocalCommand("ssh-add", ["-L"], options());
  assertSshLocalCommandFinished(listedKeys, "listing ssh-agent keys");
  return isKeyListed(listedKeys, publicKeyPath);
}
