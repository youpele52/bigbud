import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { readClientRelayCredentials } from "./clientRelay.credentials.ts";
import { serveClientRelayStream } from "./clientRelay.remote.ts";
import { ClientRelayStdioSocket } from "./clientRelay.stdio.ts";

// Dedicated Node entry: never import bin/CLI, providers, databases or orchestration composition.
async function main() {
  if (process.argv.length !== 3) throw new Error("One account authority is required.");
  const credentials = await readClientRelayCredentials(homedir(), process.argv[2]!);
  const stream = new ClientRelayStdioSocket(process.stdin, process.stdout);
  const relay = serveClientRelayStream({ stream, ...credentials });
  const close = () => relay.close();
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  process.stdin.once("end", close);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void main().catch(() => {
    // Never print private configuration paths, upstream errors or authentication values.
    process.stderr.write("Remote backend client relay unavailable.\n");
    process.exitCode = 1;
  });
