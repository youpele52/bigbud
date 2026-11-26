import { readFile, realpath } from "node:fs/promises";
import OS from "node:os";
import path from "node:path";

import { parseSshExecutionTarget } from "../../ssh/sshExecutionTarget.ts";
import { resolveProfileHostAuth } from "../../ssh/sshConfigProfileAliases.ts";
import type { SshOwnerTargetDescriptor } from "../../ssh/sshOwnerProductionClient.launch.ts";

/**
 * SSH Git remotes resolved the way OpenSSH would dial them (U15, user-approved 26 November
 * 2026). Both `ssh://[user@]host[:port]/path` and scp-style `[user@]host:path` remotes have their
 * host looked up in `~/.ssh/config` with the same bounded, no-spawn resolver production targets
 * use, so an alias whose HostName is a bigbud target is recognised as that target.
 *
 * @module GitCore.remoteEndpoint
 */

export interface SshRemoteSpec {
  readonly host: string;
  readonly user?: string;
  readonly port?: number;
  /** As written; scp paths may be relative or start with `~`. */
  readonly path: string;
}

/** Every spelling of the dialled host, plus the user/port the remote or config states. */
export interface ResolvedSshEndpoint {
  readonly hosts: ReadonlyArray<string>;
  readonly user?: string;
  readonly port?: number;
}

const USER = "[a-zA-Z0-9_][a-zA-Z0-9_.-]*";
const HOST = "[a-zA-Z0-9][a-zA-Z0-9.-]*";
const URL_FORM = new RegExp(
  `^(?:ssh|git\\+ssh|ssh\\+git)://(?:(${USER})@)?(${HOST})(?::([1-9][0-9]{0,4}))?(/.*)$`,
  "u",
);
const SCP_FORM = new RegExp(`^(?:(${USER})@)?(${HOST}):(?!//)(.+)$`, "u");

export function parseSshRemoteSpec(url: string): SshRemoteSpec | undefined {
  // oxlint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(url)) return undefined;
  // Transport helpers (`ext::`, `<helper>::`) and other schemes are never SSH remotes.
  const scp = url.includes("::") || url.includes("://") ? null : SCP_FORM.exec(url);
  const match = URL_FORM.exec(url) ?? scp;
  if (!match) return undefined;
  const [, user, host, portText, remotePath] = URL_FORM.test(url)
    ? match
    : [match[0], match[1], match[2], undefined, match[3]];
  if (!host || !remotePath) return undefined;
  const port = portText === undefined ? undefined : Number(portText);
  if (port !== undefined && port > 65_535) return undefined;
  return {
    host: host.toLowerCase(),
    ...(user ? { user } : {}),
    ...(port !== undefined ? { port } : {}),
    path: remotePath,
  };
}

/** `%h` and `%%` only; any other token is not resolvable here. */
function expandHostName(value: string, host: string): string | undefined {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char !== "%") {
      result += char;
      continue;
    }
    const token = value[++index];
    if (token === "h") result += host;
    else if (token === "%") result += "%";
    else return undefined;
  }
  return result.toLowerCase();
}

export interface ResolveSshEndpointOptions {
  /** Test-only home directory; production uses the OS account home. */
  readonly home?: string;
}

/**
 * Resolve the remote's host through the user's SSH config. `"refused"` when the config cannot
 * be read or contains directives the resolver does not evaluate (`Match`, unsupported
 * `Include`); the caller decides whether that fails closed.
 */
export async function resolveSshEndpoint(
  spec: Pick<SshRemoteSpec, "host" | "user" | "port">,
  options: ResolveSshEndpointOptions = {},
): Promise<ResolvedSshEndpoint | "refused"> {
  const literal: ResolvedSshEndpoint = {
    hosts: [spec.host],
    ...(spec.user ? { user: spec.user } : {}),
    ...(spec.port !== undefined ? { port: spec.port } : {}),
  };
  const home = options.home ?? OS.homedir();
  const root = path.join(home, ".ssh");
  const sourcePath = path.join(root, "config");
  let content: string;
  try {
    content = await readFile(sourcePath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ? literal : "refused";
  }
  try {
    const canonical = await realpath(root);
    const resolved = await resolveProfileHostAuth({
      root: canonical,
      sourcePath,
      content,
      host: spec.host,
      home,
    });
    if (resolved.refusals.length > 0) return "refused";
    const hint = resolved.hint;
    const hostName = hint?.hostName ? expandHostName(hint.hostName, spec.host) : spec.host;
    if (!hostName) return "refused";
    const user = spec.user ?? hint?.user;
    const port = spec.port ?? (hint ? Number(hint.port) : undefined);
    return {
      hosts: hostName === spec.host ? [spec.host] : [spec.host, hostName],
      ...(user ? { user } : {}),
      ...(port !== undefined && Number.isInteger(port) ? { port } : {}),
    };
  } catch {
    return "refused";
  }
}

/**
 * Owner serving needs the exact dial: an unstated user is the local account and an unstated
 * port is 22, as OpenSSH would use. The dialled host must be the descriptor's host or the
 * target id's own host spelling.
 */
export function endpointServesTarget(
  endpoint: ResolvedSshEndpoint,
  targetId: string,
  descriptor: SshOwnerTargetDescriptor,
  localUser: string = OS.userInfo().username,
): boolean {
  const target = parseSshExecutionTarget(targetId);
  if (!target || target.transport === "agent") return false;
  const dialled = endpoint.hosts.at(-1);
  const spellings = [descriptor.host.toLowerCase(), target.host.toLowerCase()];
  return (
    dialled !== undefined &&
    spellings.includes(dialled) &&
    (endpoint.user ?? localUser) === descriptor.user &&
    (endpoint.port ?? 22) === descriptor.port
  );
}
