import { createServer } from "node:http";
import type { OpencodeV2Client } from "./Client.ts";
import { sharedServiceTestRegistration } from "./SharedService.test.fixture.ts";
import { readV2SharedRegistration, v2SharedGeneration } from "./SharedService.registration.ts";
import { bindV2NativeCompatibility } from "./NativeCompatibility.binding.ts";
import { v2CanonicalApiFixture } from "./NativeCompatibility.api.fixture.ts";

/** Disposable loopback health/spec transport for the production verifier. No retail
 * executable, candidate ticket, completed evidence record or external connection is used. */
export async function makeV2RuntimeCheckedTransport(client: OpencodeV2Client, version: string) {
  const server = createServer((request, response) => {
    if (!request.headers.authorization) {
      response.writeHead(401).end();
      return;
    }
    const value =
      request.url === "/api/info"
        ? { version, pid: process.pid }
        : request.url === "/openapi.json"
          ? v2CanonicalApiFixture()
          : undefined;
    if (!value) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Synthetic transport address missing");
  const registration = await sharedServiceTestRegistration({
    version,
    pid: process.pid,
    url: `http://127.0.0.1:${address.port}`,
  });
  const native = await readV2SharedRegistration(registration.file);
  let current = true;
  const descriptor = {
    registrationFile: registration.file,
    generation: v2SharedGeneration(native),
    storageIdentity: "runtime-only-synthetic-history",
  };
  bindV2NativeCompatibility(client, {
    descriptor,
    assertCurrent: () => {
      if (!current) throw new Error("Synthetic native transport closed");
    },
  });
  return {
    descriptor,
    close: async () => {
      current = false;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await registration.close();
    },
  };
}
