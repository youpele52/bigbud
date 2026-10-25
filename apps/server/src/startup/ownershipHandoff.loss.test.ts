import { createConnection, createServer, type Socket } from "node:net";
import { expect, it } from "vitest";
import { requestOwnershipControl } from "@bigbud/shared/backendOwnership.control";
import { ownershipHandoffFixture } from "./ownershipHandoff.test-fixture";

it.skipIf(process.platform === "win32")(
  "a new requester recovers after the authenticated prepare response is lost",
  async () => {
    const f = await ownershipHandoffFixture();
    const sockets = new Set<Socket>();
    const proxy = createServer((client) => {
      const upstream = createConnection({ host: "127.0.0.1", port: f.control.port });
      sockets.add(client);
      sockets.add(upstream);
      client.on("error", () => {});
      upstream.on("error", () => client.destroy());
      client.once("close", () => {
        sockets.delete(client);
        upstream.destroy();
      });
      upstream.once("close", () => sockets.delete(upstream));
      client.pipe(upstream);
      let buffered = Buffer.alloc(0),
        count = 0;
      upstream.on("data", (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE()) {
          const size = 4 + buffered.readUInt32BE();
          const frame = buffered.subarray(0, size);
          buffered = buffered.subarray(size);
          if (++count === 1)
            client.write(frame); // Relay the authentication challenge unchanged.
          else {
            client.destroy();
            upstream.destroy();
          } // Lose only the prepared response.
        }
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      const address = proxy.address();
      if (!address || typeof address === "string") throw new Error("proxy did not listen");
      await expect(
        requestOwnershipControl(
          { ...f.control, port: address.port },
          {
            version: 1,
            action: "prepare",
            operation: "a".repeat(32),
            identity: f.identity,
          },
        ),
      ).rejects.toThrow();
      expect(f.prepared()).toBe(true);
      expect(f.shutdown).not.toHaveBeenCalled();
      expect(await f.request("prepare", undefined, "b".repeat(32))).toBe("prepared");
      expect(await f.request("commit", undefined, "b".repeat(32))).toBe("committed");
      expect(f.shutdown).toHaveBeenCalledOnce();
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
