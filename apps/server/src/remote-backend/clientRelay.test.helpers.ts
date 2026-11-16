import * as http from "node:http";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { ClientRelayStdioSocket } from "./clientRelay.stdio.ts";
import { serveClientRelayStream } from "./clientRelay.remote.ts";

export function pair() {
  const a = new PassThrough(),
    b = new PassThrough();
  return { client: new ClientRelayStdioSocket(a, b), server: new ClientRelayStdioSocket(b, a) };
}
export async function backend(handler: http.RequestListener) {
  const root = await fs.mkdtemp(join(tmpdir(), "bb-rly-"));
  const socketPath = join(root, "backend.sock");
  const server = http.createServer(handler);
  const peers = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  await fs.chmod(socketPath, 0o600);
  return {
    server,
    socketPath,
    async close() {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
export function remote(socketPath: string, token: string) {
  const streams = pair();
  const helper = serveClientRelayStream({ stream: streams.server, socketPath, token });
  return {
    stream: streams.client,
    close() {
      helper.close();
      streams.client.destroy();
    },
  };
}
export function request(
  socket: import("node:stream").Duplex,
  path: string,
  headers: http.OutgoingHttpHeaders = {},
) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const agent = new http.Agent();
      agent.createConnection = () => socket;
      const req = http.request({ method: "GET", path, headers, agent }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode!,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
        response.once("error", reject);
      });
      req.once("error", reject);
      req.end();
    },
  );
}
