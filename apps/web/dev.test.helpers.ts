import { createServer } from "node:net";

export async function listenWebDevTestSocket(host = "127.0.0.1") {
  // macOS can assign 65535 for listen(0). Collision tests need room to scan
  // upward, so retain an actual ephemeral listener with enough headroom.
  for (let attempt = 0; attempt < 1024; attempt++) {
    const socket = createServer();
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(0, host, resolve);
    });
    const address = socket.address();
    if (address && typeof address !== "string" && address.port <= 65000) return socket;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
  }
  throw new Error("Could not allocate an ephemeral test port with retry headroom");
}
