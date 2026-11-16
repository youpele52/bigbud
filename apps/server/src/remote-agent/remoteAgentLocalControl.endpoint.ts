import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Windows transport for the D1 local control channel. Node cannot attach an account-only
 * security descriptor to a named pipe, so authority comes from two facts instead:
 * - the default named-pipe DACL gives other non-admin accounts read-only access, which cannot
 *   send a request or create a competing instance of a first-instance pipe; and
 * - every request must carry a random token that is only stored, with the random pipe name, in
 *   this account's private bigbud state directory. Reading that file proves same-account access.
 */
export type RemoteAgentControlTransport = "unix-socket" | "named-pipe";

export const REMOTE_AGENT_CONTROL_ENDPOINT_FILE = "remote-agent.endpoint.json";
const PIPE_PREFIX = "\\\\.\\pipe\\bigbud-remote-agent-";
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export interface RemoteAgentControlEndpoint {
  readonly address: string;
  readonly token: string;
}

export function defaultRemoteAgentControlTransport(): RemoteAgentControlTransport {
  return process.platform === "win32" ? "named-pipe" : "unix-socket";
}

export function remoteAgentControlEndpointPath(controlDir: string): string {
  return join(controlDir, REMOTE_AGENT_CONTROL_ENDPOINT_FILE);
}

/** A fresh, unpredictable pipe name and token for each backend start. */
export function createRemoteAgentControlEndpoint(
  pipeAddress: (id: string) => string = (id) => `${PIPE_PREFIX}${id}`,
): RemoteAgentControlEndpoint {
  return {
    address: pipeAddress(randomBytes(16).toString("hex")),
    token: randomBytes(32).toString("hex"),
  };
}

/** Publish only after the pipe is listening; atomic so a client never reads a partial file. */
export async function writeRemoteAgentControlEndpoint(
  controlDir: string,
  endpoint: RemoteAgentControlEndpoint,
): Promise<void> {
  const path = remoteAgentControlEndpointPath(controlDir);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(endpoint)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function removeRemoteAgentControlEndpoint(
  controlDir: string,
  endpoint: RemoteAgentControlEndpoint,
): Promise<void> {
  const current = await readRemoteAgentControlEndpoint(controlDir, () => true);
  // A newer backend may already own the file; remove only our own publication.
  if (current?.token === endpoint.token)
    await rm(remoteAgentControlEndpointPath(controlDir), { force: true });
}

/** Read the published endpoint; malformed or foreign-looking content is treated as absent. */
export async function readRemoteAgentControlEndpoint(
  controlDir: string,
  addressAllowed: (address: string) => boolean = (address) =>
    address.startsWith(PIPE_PREFIX) && /^[0-9a-f]{32}$/.test(address.slice(PIPE_PREFIX.length)),
): Promise<RemoteAgentControlEndpoint | null> {
  let raw: string;
  try {
    raw = await readFile(remoteAgentControlEndpointPath(controlDir), "utf8");
  } catch {
    return null;
  }
  if (raw.length > 1024) return null;
  try {
    const value = JSON.parse(raw) as Partial<RemoteAgentControlEndpoint>;
    if (
      typeof value.address !== "string" ||
      typeof value.token !== "string" ||
      !TOKEN_PATTERN.test(value.token) ||
      !addressAllowed(value.address)
    )
      return null;
    return { address: value.address, token: value.token };
  } catch {
    return null;
  }
}

export function remoteAgentControlTokenMatches(expected: string, received: unknown): boolean {
  if (typeof received !== "string" || received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}
