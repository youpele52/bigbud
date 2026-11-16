import * as https from "node:https";
import type * as http from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";
import { probeMobileGatewayHttps } from "./mobileGatewayProbe.ts";

vi.mock("node:https", () => ({ request: vi.fn() }));
const expected = () => ({
  handshakeRevision: 1 as const,
  authority: {
    authorityId: "a".repeat(32),
    keyEpoch: 1,
    keyFingerprint: `sha256:${"b".repeat(64)}`,
  },
  installationFingerprint: `sha256:${"c".repeat(64)}`,
  backendVersion: "1.0.0",
  mobileRpcRevision: 1 as const,
  mobileCapable: false,
});
beforeEach(() => {
  vi.mocked(https.request).mockReset();
});

it("uses exact external TLS destination with default certificate validation and no credentials", async () => {
  const response = Object.assign(new PassThrough(), {
    statusCode: 200,
    headers: { "content-type": "application/json" },
  });
  vi.mocked(https.request).mockImplementation((...args) => {
    const options = args[0] as https.RequestOptions;
    expect(options).toMatchObject({
      protocol: "https:",
      hostname: "fixture.example.ts.net",
      port: 443,
      method: "GET",
      path: "/api/mobile/handshake",
      agent: false,
      headers: { host: "fixture.example.ts.net", origin: "https://fixture.example.ts.net" },
    });
    expect(options.rejectUnauthorized).toBeUndefined();
    expect(options.ca).toBeUndefined();
    expect(options.checkServerIdentity).toBeUndefined();
    expect(options.auth).toBeUndefined();
    expect(options.headers).not.toHaveProperty("authorization");
    const callback = args.at(-1) as (response: http.IncomingMessage) => void;
    return Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      end: () =>
        queueMicrotask(() => {
          callback(response as unknown as http.IncomingMessage);
          response.end(JSON.stringify(expected()));
        }),
    }) as unknown as http.ClientRequest;
  });
  await probeMobileGatewayHttps({
    externalOrigin: "https://fixture.example.ts.net",
    expected: expected(),
    signal: new AbortController().signal,
  });
  expect(https.request).toHaveBeenCalledTimes(1);
});

it("refuses an origin on another TLS port before network IO", async () => {
  await expect(
    probeMobileGatewayHttps({
      externalOrigin: "https://fixture.example.ts.net:8443",
      expected: expected(),
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
  expect(https.request).not.toHaveBeenCalled();
});

it("fails closed on TLS failure without retrying or following another destination", async () => {
  vi.mocked(https.request).mockImplementation(() => {
    const request = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      end: () => queueMicrotask(() => request.emit("error", new Error("certificate failure"))),
    });
    return request as unknown as http.ClientRequest;
  });
  await expect(
    probeMobileGatewayHttps({
      externalOrigin: "https://fixture.example.ts.net",
      expected: expected(),
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
  expect(https.request).toHaveBeenCalledTimes(1);
});
