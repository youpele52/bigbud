import { access, readFile, realpath } from "node:fs/promises";
import OS from "node:os";
import path from "node:path";

import { resolveProfileHostAuth, type SshConfigHostAuth } from "./sshConfigProfileAliases.ts";
import type { SshConfigAliasHint } from "./sshConfigProfileAliases.ts";
import { parseSshExecutionTarget } from "./sshExecutionTarget.ts";
import { isDescriptorHost, validateTargetDescriptor } from "./sshOwnerPickerProof.codec.target.ts";
import type { SshOwnerTargetDescriptor } from "./sshOwnerProductionClient.launch.ts";

/**
 * Production per-target descriptor resolution (W3.7).
 *
 * Maps a runtime `ssh:` target id to the exact descriptor the owner admits.
 * Identity and known-hosts files come from the user's own SSH config for that
 * host (`~/.ssh/config`, read through the bounded, no-spawn alias resolver), or
 * from the target's explicit `keyPath`. A DNS host name is passed through
 * unchanged: the owner resolves it, never this process. Anything that cannot be
 * determined, or that needs password or agent authentication, is a typed
 * refusal rather than a guess.
 *
 * @module sshOwnerProductionTargets
 */

export type SshOwnerTargetRefusalReason =
  | "not-ssh-target"
  | "password-auth"
  | "agent-auth"
  | "no-identity"
  | "no-known-hosts"
  | "no-user"
  | "host-invalid"
  | "config-unreadable"
  | "config-refused"
  | "descriptor-invalid";

export class SshOwnerTargetRefusal extends Error {
  constructor(readonly reason: SshOwnerTargetRefusalReason) {
    super(`The SSH owner cannot resolve this target (${reason}); it stays refused.`);
    this.name = "SshOwnerTargetRefusal";
  }
}

export interface ResolveProductionTargetOptions {
  /** Test-only home directory; production uses the OS account home. */
  readonly home?: string;
}

const expandHome = (value: string, home: string) =>
  value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value;

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

interface HostConfig {
  readonly hint: SshConfigAliasHint | undefined;
  readonly auth: SshConfigHostAuth;
}

/**
 * The user's SSH config facts for `host`. An alias must be declared by a `Host`
 * line; a structured host is still evaluated so `Host *` defaults apply. No
 * config file at all yields no facts.
 */
async function readHostConfig(home: string, host: string, alias: boolean): Promise<HostConfig> {
  const root = path.join(home, ".ssh");
  const sourcePath = path.join(root, "config");
  let content: string;
  try {
    content = await readFile(sourcePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
      return { hint: undefined, auth: {} };
    throw new SshOwnerTargetRefusal("config-unreadable");
  }
  const resolved = await resolveProfileHostAuth({
    root: await realpath(root),
    sourcePath,
    content,
    host,
  }).catch(() => {
    throw new SshOwnerTargetRefusal("config-unreadable");
  });
  // A refused source (for example an unevaluated `Match`) fails closed.
  if (resolved.refusals.length > 0) throw new SshOwnerTargetRefusal("config-refused");
  if (alias && !resolved.declared) return { hint: undefined, auth: {} };
  return { hint: resolved.hint, auth: resolved.auth };
}

/** Whether `descriptor` is the one this resolver produces for `targetId`. */
export function descriptorServesTarget(
  descriptor: SshOwnerTargetDescriptor,
  targetId: string,
): boolean {
  return descriptor.kind === "alias"
    ? `ssh:${descriptor.targetId}` === targetId
    : descriptor.targetId === targetId;
}

/**
 * Resolves the owner descriptor for one runtime target id. Throws
 * `SshOwnerTargetRefusal` with a typed reason; never returns a partial value.
 */
export async function resolveProductionTargetDescriptor(
  targetId: string,
  options: ResolveProductionTargetOptions = {},
): Promise<SshOwnerTargetDescriptor> {
  const target = parseSshExecutionTarget(targetId);
  if (!target) throw new SshOwnerTargetRefusal("not-ssh-target");
  if (target.authMode === "password") throw new SshOwnerTargetRefusal("password-auth");
  const home = options.home ?? OS.homedir();
  // A bare `ssh:<alias>` names a config alias; parameters name a structured target.
  const kind = target.executionTargetId.includes("=") ? "structured" : "alias";
  const { hint, auth } = await readHostConfig(home, target.host, kind === "alias");
  if (kind === "alias" && !hint) throw new SshOwnerTargetRefusal("config-refused");
  const identity = target.keyPath ?? auth.identityFile;
  if (!identity) {
    const agent = auth.identityAgent;
    throw new SshOwnerTargetRefusal(
      agent && agent.toLowerCase() !== "none" ? "agent-auth" : "no-identity",
    );
  }
  const configuredTrust = auth.userKnownHostsFile;
  const knownHostsFile = expandHome(configuredTrust ?? "~/.ssh/known_hosts", home);
  // Without a configured file, OpenSSH's documented default must exist.
  if (configuredTrust === undefined && !(await exists(knownHostsFile)))
    throw new SshOwnerTargetRefusal("no-known-hosts");
  const host = kind === "alias" ? (hint?.hostName ?? target.host) : target.host;
  if (!isDescriptorHost(host)) throw new SshOwnerTargetRefusal("host-invalid");
  const user = target.user ?? hint?.user;
  if (!user) throw new SshOwnerTargetRefusal("no-user");
  const descriptor: SshOwnerTargetDescriptor = {
    // The owner re-resolves an alias descriptor's policy by its target id, so
    // an alias descriptor carries the bare alias; a structured one keeps the id.
    targetId: kind === "alias" ? target.host : targetId,
    kind,
    host,
    port: Number(target.port ?? hint?.port ?? "22"),
    user,
    authMode: "key",
    identityFile: expandHome(identity, home),
    knownHostsFile,
    ...(hint?.hostKeyAlias ? { hostKeyAlias: hint.hostKeyAlias } : {}),
  };
  try {
    validateTargetDescriptor(descriptor);
  } catch {
    throw new SshOwnerTargetRefusal("descriptor-invalid");
  }
  return descriptor;
}
