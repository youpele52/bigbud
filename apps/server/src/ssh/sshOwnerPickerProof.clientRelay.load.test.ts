import { once } from "node:events";
import * as http from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

import { openClientRelayOwner } from "../remote-backend/clientRelay.owner.ts";
import { makeClientRelaySshChannels } from "../remote-backend/clientRelay.ssh.ts";
import type {
  ClientRelayOwnerExit,
  ClientRelayOwnerRequest,
} from "../remote-backend/clientRelay.ssh.owner.ts";
import { ClientRelayStdioSocket } from "../remote-backend/clientRelay.stdio.ts";
import { backend, remote } from "../remote-backend/clientRelay.test.helpers.ts";

const legacy = vi.hoisted(() => ({
  ready: vi.fn(),
  trust: vi.fn(),
  build: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock("../ssh/sshVerification.ts", () => ({ assertSshExecutionTargetReadyAsync: legacy.ready }));
vi.mock("../ssh/sshHostTrust.ts", () => ({ inspectSshHostTrust: legacy.trust }));
vi.mock("../ssh/sshCommand.ts", () => ({ buildSshCommandInvocation: legacy.build }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: legacy.spawn,
}));

afterEach(() => {
  for (const call of Object.values(legacy)) {
    expect(call).not.toHaveBeenCalled();
    call.mockClear();
  }
});

const target = {
  executionTargetId: "ssh:host=relay-load&user=viewer&port=2022",
  deployment: {
    nodeBinary: "/private/node",
    nodeSha256: "a".repeat(64),
    helperEntry: "/private/relay.mjs",
    helperSha256: "b".repeat(64),
    authorityId: "c".repeat(32),
  },
} satisfies ClientRelayOwnerRequest;
const signal = () => new AbortController().signal;

interface Channel {
  readonly stream: ReturnType<typeof remote>["stream"];
  readonly close: () => void;
  readonly exit: Promise<ClientRelayOwnerExit>;
  readonly stop: () => void;
}

/** One owned transport per channel, like one SSH child per relay lease. */
function ownedHelper(socketPath: string) {
  const helper = remote(socketPath, "Bearer internal-fixture");
  const deferred = Promise.withResolvers<ClientRelayOwnerExit>();
  const channel: Channel = {
    stream: helper.stream,
    close: helper.close,
    exit: deferred.promise,
    stop() {
      helper.close();
      deferred.resolve({ kind: "exited", code: 0 });
    },
  };
  return channel;
}

async function collaboration(
  handler: http.RequestListener,
  body: (input: {
    readonly baseUrl: string;
    readonly token: string;
    readonly channels: Channel[];
  }) => Promise<void>,
) {
  const upstream = await backend(handler);
  const channels: Channel[] = [];
  let owner: Awaited<ReturnType<typeof openClientRelayOwner>> | undefined;
  try {
    owner = await openClientRelayOwner({
      allowedOrigins: ["https://app.invalid"],
      openChannel: async () => {
        const channel = ownedHelper(upstream.socketPath);
        channels.push(channel);
        return channel.stream;
      },
    });
    await body({ baseUrl: owner.baseUrl, token: owner.token, channels });
  } finally {
    for (const channel of channels) channel.stop();
    owner?.dispose();
    await upstream.close();
  }
}

const authorized = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "x-bigbud-client-rpc-revision": "1",
  origin: "https://app.invalid",
});

it("serves parallel channels without sharing one transport or dropping a response", async () => {
  await collaboration(
    (request, response) => {
      setTimeout(() => response.end(request.url), 20);
    },
    async ({ baseUrl, token, channels }) => {
      const paths = ["/one", "/two", "/three", "/four"];
      const results = await Promise.all(
        paths.map(async (path) => {
          const response = await fetch(baseUrl + path, { headers: authorized(token) });
          return response.text();
        }),
      );
      expect(results).toEqual(paths);
      expect(channels).toHaveLength(paths.length);
      expect(new Set(channels.map((channel) => channel.stream)).size).toBe(paths.length);
    },
  );
});

it("keeps control responsive while one reader has stopped consuming", async () => {
  await collaboration(
    (request, response) => {
      if (request.url === "/slow") {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        // One chunk is enough: the paused reader must backpressure the relay
        // instead of growing a buffer, and the pool keeps capacity for control.
        response.write(Buffer.alloc(64 * 1024, 7));
        return;
      }
      response.end("control");
    },
    async ({ baseUrl, token }) => {
      const stalled = http.get(baseUrl + "/slow", { headers: authorized(token) });
      const [stalledResponse] = (await once(stalled, "response")) as [http.IncomingMessage];
      // Never read: the relay's own socket is paused, so its buffer stays bounded
      // by the channel high-water mark instead of growing with the writer.
      expect(stalledResponse.readableLength).toBeLessThan(2 * 64 * 1024);
      const control = await Promise.race([
        fetch(baseUrl + "/control", { headers: authorized(token) }).then((r) => r.text()),
        new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 2_000)),
      ]);
      expect(control).toBe("control");
      stalledResponse.destroy();
      stalled.destroy();
    },
  );
});

it("preserves a half-closed upload under load and returns the complete response", async () => {
  const payload = Buffer.alloc(256 * 1024);
  for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
  await collaboration(
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.once("end", () => {
        const received = Buffer.concat(chunks);
        response.end(String(received.length));
      });
    },
    async ({ baseUrl, token }) => {
      const response = await fetch(baseUrl + "/upload", {
        method: "POST",
        headers: { ...authorized(token), "content-type": "application/octet-stream" },
        body: payload,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(String(payload.length));
    },
  );
});

it("retains a descendant's final bytes after confirmed exit and drains every lease", async () => {
  const pipes = () => {
    const stdin = new PassThrough({ highWaterMark: 1024 });
    const stdout = new PassThrough({ highWaterMark: 1024 });
    return { stdin, stdout, stream: new ClientRelayStdioSocket(stdout, stdin) };
  };
  const first = pipes();
  const second = pipes();
  const exits = [
    Promise.withResolvers<ClientRelayOwnerExit>(),
    Promise.withResolvers<ClientRelayOwnerExit>(),
  ];
  const cancels = [vi.fn(async () => {}), vi.fn(async () => {})];
  const leases = [first, second].map((pipes, index) => ({
    stream: pipes.stream,
    exit: exits[index]!.promise,
    cancel: cancels[index]!,
  }));
  const owner = makeClientRelaySshChannels({
    ...target,
    sshOwner: {
      openClientRelay: vi.fn().mockResolvedValueOnce(leases[0]).mockResolvedValueOnce(leases[1]),
    },
  });
  const channels = await Promise.all([owner.openChannel(signal()), owner.openChannel(signal())]);
  expect(channels).toHaveLength(2);

  // The SSH child exits while a proxy descendant still holds the pipe open; the
  // suffix must stay readable and the stream must not be destroyed.
  const suffix = Buffer.from([9, 8, 7]);
  const trailing = collect(channels[0]!);
  exits[0]!.resolve({ kind: "exited", code: 0 });
  await exits[0]!.promise;
  expect(channels[0]!.destroyed).toBe(false);
  first.stdout.end(suffix);
  expect(await trailing).toEqual(suffix);

  const disposal = owner.dispose();
  await once(channels[1]!, "close");
  exits[1]!.resolve({ kind: "signaled", signal: "SIGTERM" });
  await disposal;
  // A confirmed exit needs no cancellation; the unconfirmed sibling is asked to stop.
  expect(cancels[0]).not.toHaveBeenCalled();
  expect(cancels[1]).toHaveBeenCalledTimes(1);
});

async function collect(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
