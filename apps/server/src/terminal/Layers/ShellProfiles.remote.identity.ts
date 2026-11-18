import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import { ShellHostScope } from "@bigbud/contracts/workspace/terminalShell.ts";
import type { TerminalWslIdentity } from "@bigbud/contracts/workspace/terminal.wsl.ts";
import { parseWslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";
import { parseSshExecutionTarget } from "../../ssh/sshExecutionTarget";

export class RemoteShellDiscoveryError extends Schema.TaggedErrorClass<RemoteShellDiscoveryError>()(
  "RemoteShellDiscoveryError",
  { reason: Schema.Literals(["probe-failed", "timed-out", "unsupported-target"]) },
) {}

export interface RemoteShellDiscoveryInput {
  readonly executionTargetId: string;
  readonly wslIdentity?: TerminalWslIdentity;
}

const unsupported = () => new RemoteShellDiscoveryError({ reason: "unsupported-target" });
const hostId = (identity: readonly unknown[]) =>
  createHash("sha256").update(JSON.stringify(identity)).digest("hex");

export function sshShellTarget(input: RemoteShellDiscoveryInput) {
  const target = parseSshExecutionTarget(input.executionTargetId);
  if (!target || input.wslIdentity) throw unsupported();
  let host = target.host;
  let user = target.user;
  // The parser preserves legacy user@host syntax; normalize it with structured targets.
  const separator = host.lastIndexOf("@");
  if (separator !== -1) {
    if (user) throw unsupported();
    user = host.slice(0, separator);
    host = host.slice(separator + 1);
  }
  if (
    !host ||
    host.startsWith("-") ||
    // oxlint-disable-next-line no-control-regex -- Reject option/control-bearing SSH destinations.
    /[\x00-\x20\x7f-\x9f@]/.test(host) ||
    !user ||
    user.startsWith("-") ||
    // oxlint-disable-next-line no-control-regex -- SSH account names cannot carry controls.
    /[\x00-\x20\x7f-\x9f@]/u.test(user) ||
    (target.port !== undefined &&
      (!/^\d{1,5}$/.test(target.port) || Number(target.port) < 1 || Number(target.port) > 65535))
  )
    throw unsupported();
  return { host, user, port: Number(target.port ?? 22) };
}

/** Pure configured identity resolution, not evidence of a successful launch.
 * SSH requires an explicit user, verified by the inventory probe before any output.
 * Credentials and transport are absent from the hash; rotating either does not
 * change the account. This module must not load discovery or connection clients.
 */
export function remoteShellHost(input: RemoteShellDiscoveryInput): ShellHostScope {
  const distribution = parseWslTerminalTargetId(input.executionTargetId);
  if (distribution) {
    const identity = input.wslIdentity;
    if (
      !identity ||
      identity.distribution !== distribution ||
      !Number.isSafeInteger(identity.uid) ||
      identity.uid < 0 ||
      !identity.username ||
      // oxlint-disable-next-line no-control-regex -- Pinned Linux account identity, not shell text.
      /[\x00-\x20\x7f-\x9f]/.test(identity.username)
    )
      throw unsupported();
    const host = {
      kind: "wsl" as const,
      hostId: hostId(["wsl", distribution, identity.username]),
      distribution,
      username: identity.username,
    };
    if (!Schema.is(ShellHostScope)(host)) throw unsupported();
    return host;
  }
  const target = sshShellTarget(input);
  return {
    kind: "ssh",
    hostId: hostId(["ssh", target.host.toLowerCase(), target.user, target.port]),
  };
}
