import { createServer, type Server } from "node:http";
import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { discoverV2SharedService } from "./SharedService.discovery.ts";
import {
  sharedServiceTestContract,
  sharedServiceTestRegistration,
} from "./SharedService.test.fixture.ts";

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture listener failed.");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

it("real HTTP redirect cannot forward native transport auth to another origin", async () => {
  let foreignRequests = 0;
  const foreign = createServer((request, response) => {
    request.resume();
    foreignRequests++;
    response.end("unexpected");
  });
  const foreignOrigin = await listen(foreign);
  const local = createServer((request, response) => {
    request.resume();
    expect(request.headers.authorization).toBe(
      `Basic ${Buffer.from("opencode:private-fixture-password").toString("base64")}`,
    );
    response.writeHead(302, { location: `${foreignOrigin}/api/info` }).end();
  });
  const origin = await listen(local);
  const fixture = await sharedServiceTestRegistration({ url: origin });
  try {
    await expect(discoverV2SharedService({ file: fixture.file })).rejects.toThrow(
      "health could not be verified",
    );
    expect(foreignRequests).toBe(0);
  } finally {
    await close(local);
    await close(foreign);
    await fixture.close();
  }
});

it("auth rotation changes handshake but never invents a new storage/generation identity", async () => {
  const fixture = await sharedServiceTestRegistration();
  const calls: string[] = [];
  const local = createServer((request, response) => {
    request.resume();
    calls.push(request.method!);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url === "/api/info" ? { version: "2.0.24", pid: 42 } : sharedServiceTestContract(),
      ),
    );
  });
  const origin = await listen(local);
  try {
    await writeFile(fixture.file, JSON.stringify({ ...fixture.value, url: origin }));
    const first = await discoverV2SharedService({ file: fixture.file });
    await writeFile(
      fixture.file,
      JSON.stringify({ ...fixture.value, url: origin, password: "rotated-fixture-password" }),
    );
    const second = await discoverV2SharedService({ file: fixture.file });
    expect(first.generation).toBe(second.generation);
    expect(calls).toEqual(["GET", "GET", "GET", "GET"]);
    expect(first).not.toHaveProperty("storageIdentity");
  } finally {
    await close(local);
    await fixture.close();
  }
});
