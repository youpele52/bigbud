import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { assertPrivateRelaySocket, readRelayServiceRoot } from "./clientRelay.credentials.ts";
import { ClientRelayStdioSocket } from "./clientRelay.stdio.ts";
import { parsePeerRelayArguments, servePeerRelayStream } from "./peerRelay.remote.ts";

/** The worker's peer socket for this account authority; never the client or mobile socket. */
export async function readPeerRelaySocket(homeDir: string, authorityId: string) {
  const { stateDir } = await readRelayServiceRoot(homeDir, authorityId);
  return assertPrivateRelaySocket(join(stateDir, "remote-peer.sock"));
}

/**
 * The forced command's whole behavior: fixed argv in, one peer-socket relay over stdio out.
 * `SSH_ORIGINAL_COMMAND` and the environment are ignored; the coordinator cannot choose a socket.
 */
export async function runPeerRelay(input: {
  readonly argv: ReadonlyArray<string>;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly resolveSocket: (workerAuthorityId: string) => Promise<string>;
}) {
  const { workerAuthorityId, credential } = parsePeerRelayArguments(input.argv);
  const socketPath = await input.resolveSocket(workerAuthorityId);
  const stream = new ClientRelayStdioSocket(input.stdin, input.stdout);
  const relay = servePeerRelayStream({ stream, socketPath, credential });
  input.stdin.once("end", () => relay.close());
  return relay;
}

// Dedicated Node entry: never import bin/CLI, providers, databases or orchestration composition.
async function main() {
  const relay = await runPeerRelay({
    argv: process.argv.slice(2),
    stdin: process.stdin,
    stdout: process.stdout,
    resolveSocket: (authorityId) => readPeerRelaySocket(homedir(), authorityId),
  });
  process.once("SIGTERM", relay.close);
  process.once("SIGINT", relay.close);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void main().catch(() => {
    // Never print private configuration paths, upstream errors or grant values.
    process.stderr.write("Remote backend peer relay unavailable.\n");
    process.exitCode = 1;
  });
