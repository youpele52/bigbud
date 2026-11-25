import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const IDENTITIES_REQUEST = 11;
const IDENTITIES_ANSWER = 12;
const SIGN_REQUEST = 13;
const SIGN_RESPONSE = 14;
const FAILURE = 5;
const MAX_FRAME = 64 * 1024;

const sshString = (value: Buffer) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
};
const frame = (type: number, body: Buffer) => sshString(Buffer.concat([Buffer.from([type]), body]));

/**
 * Disposable host-key agent for the private Linux fixture sshd (`HostKeyAgent`). Holding the one
 * armed signature keeps a real OpenSSH handshake in flight: the client has connected and sent
 * its key exchange, and cannot authenticate until the server proves its host key. sshd's
 * `AuthorizedKeysCommand` cannot be used rootless (bwrap maps real root to the overflow uid).
 */
export async function startHostKeyAgentGate(root: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url");
  const blob = Buffer.concat([sshString(Buffer.from("ssh-ed25519")), sshString(raw)]);
  const publicLine = `ssh-ed25519 ${blob.toString("base64")}`;
  await writeFile(path.join(root, "host-key.pub"), `${publicLine} host-key-gate\n`, {
    mode: 0o600,
  });
  const socket = path.join(root, "hostkey-agent.sock");
  let armed = false;
  let held = false;
  let release = Promise.withResolvers<void>();
  const answer = async (key: KeyObject, request: Buffer): Promise<Buffer> => {
    const type = request[0];
    if (type === IDENTITIES_REQUEST) {
      const count = Buffer.alloc(4);
      count.writeUInt32BE(1);
      return frame(
        IDENTITIES_ANSWER,
        Buffer.concat([count, sshString(blob), sshString(Buffer.from("gate"))]),
      );
    }
    if (type !== SIGN_REQUEST) return frame(FAILURE, Buffer.alloc(0));
    const keyLength = request.readUInt32BE(1);
    const dataStart = 5 + keyLength;
    if (!request.subarray(5, dataStart).equals(blob)) return frame(FAILURE, Buffer.alloc(0));
    const data = request.subarray(dataStart + 4, dataStart + 4 + request.readUInt32BE(dataStart));
    if (armed && !held) {
      held = true;
      await release.promise;
    }
    const signature = sign(null, data, key);
    return frame(
      SIGN_RESPONSE,
      sshString(Buffer.concat([sshString(Buffer.from("ssh-ed25519")), sshString(signature)])),
    );
  };
  const server = net.createServer((connection) => {
    let pending = Buffer.alloc(0);
    let queue = Promise.resolve();
    connection.on("error", () => undefined);
    connection.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const length = pending.readUInt32BE(0);
        if (length === 0 || length > MAX_FRAME) return connection.destroy();
        if (pending.length < 4 + length) return;
        const request = pending.subarray(4, 4 + length);
        pending = pending.subarray(4 + length);
        queue = queue.then(async () => {
          if (!connection.destroyed) connection.write(await answer(privateKey, request));
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  return {
    sshdConfig: [`HostKey ${path.join(root, "host-key.pub")}`, `HostKeyAgent ${socket}`],
    publicLine,
    /** Hold the next host-key signature until release. */
    arm() {
      armed = true;
      held = false;
      release = Promise.withResolvers<void>();
    },
    isHeld: () => held,
    release() {
      armed = false;
      release.resolve();
    },
    close: () =>
      new Promise<void>((resolve) => {
        release.resolve();
        server.close(() => resolve());
      }),
  };
}
