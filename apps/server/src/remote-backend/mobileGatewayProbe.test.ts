import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import type { RemoteBackendMobileDescriptor } from "@bigbud/contracts/server/remoteBackendHandshake";
import { probeMobileGateway } from "./mobileGatewayProbe.ts";

const descriptor = (): RemoteBackendMobileDescriptor => ({
  handshakeRevision: 1,
  authority: {
    authorityId: "a".repeat(32),
    keyEpoch: 1,
    keyFingerprint: `sha256:${"b".repeat(64)}`,
  },
  installationFingerprint: `sha256:${"c".repeat(64)}`,
  backendVersion: "1.0.0",
  mobileRpcRevision: 1,
  mobileCapable: false,
});
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});
async function endpoint(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}
function input(port: number) {
  return {
    port,
    externalOrigin: "https://fixture.example.ts.net",
    expected: descriptor(),
    signal: new AbortController().signal,
  };
}
const reply = (response: http.ServerResponse, value: unknown) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

it("probes only the fixed handshake with external Host/Origin and no private credential", async () => {
  const port = await endpoint((request, response) => {
    expect(request.url).toBe("/api/mobile/handshake");
    expect(request.method).toBe("GET");
    expect(request.headers.host).toBe("fixture.example.ts.net");
    expect(request.headers.origin).toBe("https://fixture.example.ts.net");
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers["x-bigbud-mobile-gateway"]).toBeUndefined();
    reply(response, descriptor());
  });
  await expect(probeMobileGateway(input(port))).resolves.toBeUndefined();
});

it.each([
  { handshakeRevision: 2 },
  { mobileRpcRevision: 2 },
  { backendVersion: "2.0.0" },
  { authority: { ...descriptor().authority, authorityId: "d".repeat(32) } },
  { authority: { ...descriptor().authority, keyEpoch: 2 } },
  { authority: { ...descriptor().authority, keyFingerprint: `sha256:${"e".repeat(64)}` } },
  { installationFingerprint: `sha256:${"f".repeat(64)}` },
  { privateToken: "must-not-escape" },
])("rejects a mismatching or extended identity %#", async (change) => {
  const port = await endpoint((_request, response) =>
    reply(response, { ...descriptor(), ...change }),
  );
  await expect(probeMobileGateway(input(port))).rejects.toThrow(
    /^Mobile gateway identity probe did not complete\.$/,
  );
});

it("captures the expected identity before asynchronous IO", async () => {
  const port = await endpoint((_request, response) => reply(response, descriptor()));
  const config = input(port);
  const pending = probeMobileGateway(config);
  Reflect.set(config.expected.authority, "keyEpoch", 9);
  await expect(pending).resolves.toBeUndefined();
});

it.each(["redirect", "oversized", "malformed", "encoding", "mime", "status"])(
  "rejects %s without following redirects or exposing response bytes",
  async (kind) => {
    let calls = 0;
    const port = await endpoint((_request, response) => {
      calls++;
      if (kind === "redirect") {
        response.writeHead(302, { location: "http://127.0.0.1/private-token" });
      } else {
        response.writeHead(kind === "status" ? 503 : 200, {
          "content-type": kind === "mime" ? "text/html" : "application/json",
          ...(kind === "encoding" ? { "content-encoding": "gzip" } : {}),
        });
      }
      response.end(
        kind === "oversized"
          ? "x".repeat(16385)
          : kind === "malformed"
            ? "private-token"
            : JSON.stringify(descriptor()),
      );
    });
    await expect(probeMobileGateway(input(port))).rejects.toThrow(
      "Mobile gateway identity probe did not complete.",
    );
    expect(calls).toBe(1);
  },
);

it("cancels a stalled response and releases the socket", async () => {
  let received!: () => void;
  const arrived = new Promise<void>((resolve) => {
    received = resolve;
  });
  let closed!: () => void;
  const released = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const port = await endpoint((request) => {
    request.socket.once("close", closed);
    received();
  });
  const controller = new AbortController();
  const pending = probeMobileGateway({ ...input(port), signal: controller.signal });
  const result = expect(pending).rejects.toThrow("Mobile gateway identity probe did not complete.");
  await arrived;
  controller.abort();
  await result;
  await released;
});

it("bounds a slow trickle by the absolute deadline", async () => {
  const port = await endpoint((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    const interval = setInterval(() => response.write(" "), 50);
    response.once("close", () => clearInterval(interval));
  });
  const started = Date.now();
  await expect(probeMobileGateway(input(port))).rejects.toThrow(
    "Mobile gateway identity probe did not complete.",
  );
  expect(Date.now() - started).toBeLessThan(4000);
});

it("rejects pre-aborted and invalid configuration without contacting the gateway", async () => {
  let calls = 0;
  const port = await endpoint((_request, response) => {
    calls++;
    reply(response, descriptor());
  });
  const controller = new AbortController();
  controller.abort();
  await expect(probeMobileGateway({ ...input(port), signal: controller.signal })).rejects.toThrow();
  for (const externalOrigin of [
    "http://fixture.example.ts.net",
    "https://fixture.example.ts.net/path",
    "https://owner:secret@fixture.example.ts.net",
  ])
    await expect(probeMobileGateway({ ...input(port), externalOrigin })).rejects.toThrow();
  await expect(probeMobileGateway({ ...input(port), port: 0 })).rejects.toThrow();
  expect(calls).toBe(0);
});
