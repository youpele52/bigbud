import type { ServerSshConfigHost } from "@bigbud/contracts/server/server.sshConfig";

/** Compact, value-free summary of a resolved host: destination, login, port and route. */
export function sshConfigHostHint(host: ServerSshConfigHost): string {
  return [
    host.hostName,
    host.user ? `user ${host.user}` : null,
    host.port ? `port ${host.port}` : null,
    host.route ?? null,
  ]
    .filter(Boolean)
    .join(" · ");
}
