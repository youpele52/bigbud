import { createServer } from "node:net";

// Retry tests need room above the initial candidate. On macOS an ephemeral
// allocation can reach 65535, which is unsuitable for testing port advancement.
export async function coordinatedTestPort(): Promise<number> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const address = probe.address();
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    if (!address || typeof address === "string") throw new Error("Missing ephemeral address");
    if (address.port > 5733 && address.port < 65520) return address.port;
  }
  throw new Error("Could not allocate a test port with room for collision retries");
}
