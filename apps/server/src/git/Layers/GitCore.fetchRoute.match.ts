/**
 * Remote classification and bigbud-target matching for selected-mode fetch (U14).
 *
 * @module GitCore.fetchRoute.match
 */

export type RemoteRoute =
  | { readonly kind: "local" }
  | {
      readonly kind: "ssh";
      readonly host: string;
      readonly user?: string;
      readonly port?: number;
    }
  | { readonly kind: "unsupported" };

export type SshRoute = Extract<RemoteRoute, { kind: "ssh" }>;

/** True for an SSH remote (URL or scp form); the route decides owner versus U14 fence. */
export function isSshRoute(route: RemoteRoute): route is SshRoute {
  return route.kind === "ssh";
}

/** One bigbud SSH execution target: every host spelling plus its explicit user/port, if any. */
export interface SshTargetEndpoint {
  readonly hosts: ReadonlyArray<string>;
  readonly user?: string;
  readonly port?: number;
}

function sshRoute(host: string, user: string | undefined, port: string | undefined): RemoteRoute {
  return {
    kind: "ssh",
    host: host.replace(/^\[|\]$/gu, "").toLowerCase(),
    ...(user ? { user } : {}),
    ...(port ? { port: Number(port) } : {}),
  };
}

/** Classify an `insteadOf`-expanded remote URL. */
export function classifyRemoteUrl(url: string): RemoteRoute {
  if (url.length === 0 || url.includes("\0") || /[\r\n]/u.test(url)) return { kind: "unsupported" };
  if (/^(?:https?:\/\/|file:\/\/|\/)/u.test(url)) return { kind: "local" };
  const sshUrl =
    /^(?:ssh|git\+ssh|ssh\+git):\/\/(?:([^@/]+)@)?(\[[^\]]+\]|[^:/]+)(?::(\d{1,5}))?\//u.exec(url);
  if (sshUrl?.[2]) return sshRoute(sshUrl[2], sshUrl[1], sshUrl[3]);
  if (url.includes("://") || url.includes("::")) return { kind: "unsupported" };
  // scp-like `[user@]host:path`: a colon before any slash.
  const scp = /^(?:([^@/:]+)@)?([a-zA-Z0-9][a-zA-Z0-9.-]*):(?!\/\/)/u.exec(url);
  return scp?.[2] ? sshRoute(scp[2], scp[1], undefined) : { kind: "unsupported" };
}

/**
 * A remote is a bigbud target only on a genuine match: same host spelling, and the user and
 * port agree wherever both sides state them. A side that leaves user or port unstated (scp
 * form, a target without an explicit user) cannot disprove the match, so it stays a match and
 * the fetch goes to the owner path.
 */
export function remoteMatchesTarget(
  remote: Extract<RemoteRoute, { kind: "ssh" }>,
  target: SshTargetEndpoint,
): boolean {
  return endpointMatchesTarget({ ...remote, hosts: [remote.host] }, target);
}

/**
 * The same rule over every spelling of a resolved remote (U15 scp/alias resolution): the
 * literal host and the HostName `~/.ssh/config` maps it to, with any config-stated user/port.
 */
export function endpointMatchesTarget(
  remote: { readonly hosts: ReadonlyArray<string>; readonly user?: string; readonly port?: number },
  target: SshTargetEndpoint,
): boolean {
  if (!remote.hosts.some((host) => target.hosts.includes(host))) return false;
  if (remote.user !== undefined && target.user !== undefined && remote.user !== target.user)
    return false;
  if (remote.port !== undefined && target.port !== undefined && remote.port !== target.port)
    return false;
  return true;
}

const SHELL_META = /[;&|`$()<>\\"'\n]/u;

/**
 * Add `-o BatchMode=yes` to the user's own `core.sshCommand` when it is plainly an `ssh`
 * invocation with options only (no shell syntax, no `--`, no wrapper script). Options before
 * the host are honored by OpenSSH; the first `-o BatchMode` wins, and a user `BatchMode=no`
 * written earlier still wins, which is the user's explicit choice. Anything else is returned
 * unchanged (documented residual: prompts are then prevented only by the missing TTY input
 * and `GIT_TERMINAL_PROMPT=0`).
 */
export function nonInteractiveSshCommand(userCommand: string): string | undefined {
  const words = userCommand.trim().split(/\s+/u);
  const program = words[0]?.split("/").at(-1);
  if (program !== "ssh" || SHELL_META.test(userCommand) || words.includes("--")) return undefined;
  return `${userCommand.trim()} -o BatchMode=yes`;
}
