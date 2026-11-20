import * as fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prepareRemoteClientSocket } from "./clientSocket.ts";
import { prepareRemoteMobileSocket } from "./mobileSocket.ts";
import { prepareRemotePeerSocket } from "./peerSocket.ts";

let root: string;
const held = async () => {};
const listen = (path: string) =>
  new Promise<net.Server>((resolve, reject) => {
    const server = net.createServer((socket) => socket.end());
    server.once("error", reject);
    server.listen(path, () => resolve(server));
  });
const close = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

beforeEach(async () => {
  root = await fs.mkdtemp(join(os.tmpdir(), "bb-psock-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe.runIf(process.platform !== "win32")("private remote peer socket", () => {
  it("publishes a third owner-private socket separate from the client and mobile sockets", async () => {
    const client = await prepareRemoteClientSocket(root, held);
    const mobile = await prepareRemoteMobileSocket(root, held);
    const peer = await prepareRemotePeerSocket(root, held);
    const servers = await Promise.all(
      [client, mobile, peer].map((socket) => listen(socket.bindPath)),
    );
    try {
      for (const socket of [client, mobile, peer]) await socket.seal();
      expect([client, mobile, peer].map((socket) => basename(socket.path))).toEqual([
        "remote-backend.sock",
        "remote-mobile.sock",
        "remote-peer.sock",
      ]);
      const stat = await fs.lstat(peer.path);
      expect(stat.isSocket()).toBe(true);
      expect(stat.mode & 0o7777).toBe(0o600);
      expect(stat.nlink).toBe(1);
      await peer.release();
      await expect(fs.lstat(peer.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.lstat(client.path)).isSocket()).toBe(true);
    } finally {
      await Promise.all(servers.map(close));
    }
  });

  it("refuses an unknown endpoint name", async () => {
    const { preparePrivateRemoteSocket } = await import("./privateSocket.ts");
    await expect(
      preparePrivateRemoteSocket(root, held, "__proto__" as unknown as "peer"),
    ).rejects.toThrow("Unknown remote socket endpoint");
  });
});
