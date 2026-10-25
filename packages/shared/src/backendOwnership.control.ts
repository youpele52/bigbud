import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";
import type { OwnershipControl } from "./backendOwnership.record";

const MAX_FRAME = 8192;
export type OwnershipAction = "inspect" | "prepare" | "commit" | "status";
export interface OwnershipRequest {
  readonly version: 1;
  readonly action: OwnershipAction;
  readonly operation: string;
  readonly identity: string;
}

/** Identity is pinned to an acquisition, never merely to a PID. */
export function ownershipIdentity(
  record: { pid: number; startedAt: string | null; machineId?: string | null; nonce: string },
  stateDir: string,
): string {
  return JSON.stringify([record.pid, record.startedAt, record.machineId, record.nonce, stateDir]);
}

function signature(secret: string, challenge: string, payload: string): string {
  return createHmac("sha256", secret)
    .update(`bigbud.handoff.v1\0${challenge}\0${payload}`)
    .digest("hex");
}

function authenticated(secret: string, challenge: string, raw: string): string {
  const envelope = JSON.parse(raw) as { payload?: unknown; mac?: unknown };
  if (
    typeof envelope.payload !== "string" ||
    typeof envelope.mac !== "string" ||
    !/^[a-f0-9]{64}$/.test(envelope.mac)
  )
    throw new Error("owner_unverified");
  const expected = signature(secret, challenge, envelope.payload);
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(envelope.mac, "hex")))
    throw new Error("owner_unverified");
  return envelope.payload;
}

function send(socket: Socket, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_FRAME) throw new Error("control_frame_too_large");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  socket.write(Buffer.concat([header, bytes]));
}

async function* frames(socket: Socket): AsyncGenerator<string> {
  let buffered = Buffer.alloc(0);
  let count = 0;
  for await (const chunk of socket) {
    buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
    if (buffered.length > MAX_FRAME * 2 + 8) throw new Error("control_frame_too_large");
    while (buffered.length >= 4) {
      const size = buffered.readUInt32BE();
      if (size === 0 || size > MAX_FRAME || count >= 2) throw new Error("invalid_control_frame");
      if (buffered.length < size + 4) break;
      const raw = buffered.subarray(4, size + 4).toString("utf8");
      buffered = buffered.subarray(size + 4);
      count++;
      yield raw;
    }
  }
  if (buffered.length) throw new Error("truncated_control_frame");
}

function signed(secret: string, challenge: string, value: unknown) {
  const payload = JSON.stringify(value);
  return { payload, mac: signature(secret, challenge, payload) };
}

export async function requestOwnershipControl(
  control: OwnershipControl,
  request: OwnershipRequest,
  timeoutMs = 7000,
): Promise<string> {
  const socket = createConnection({ host: "127.0.0.1", port: control.port });
  const timer = setTimeout(() => socket.destroy(new Error("supervisor_unavailable")), timeoutMs);
  let challenge: string | undefined;
  try {
    for await (const raw of frames(socket)) {
      if (!challenge) {
        const hello = JSON.parse(raw) as { challenge?: unknown };
        if (typeof hello.challenge !== "string" || !/^[a-f0-9]{64}$/.test(hello.challenge))
          throw new Error("owner_unverified");
        challenge = hello.challenge;
        send(socket, signed(control.secret, challenge, request));
      } else {
        const response = JSON.parse(authenticated(control.secret, challenge, raw)) as {
          result?: unknown;
        };
        if (typeof response.result !== "string") throw new Error("owner_unverified");
        return response.result;
      }
    }
    throw new Error("supervisor_unavailable");
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

/** A private bounded endpoint, independent of the application HTTP listener. */
export async function listenOwnershipControl(
  handle: (request: OwnershipRequest) => Promise<string>,
): Promise<{ control: OwnershipControl; close: () => Promise<void> }> {
  const secret = randomBytes(32).toString("hex");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    if (sockets.size >= 4) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), 8000);
    socket.once("close", () => {
      clearTimeout(timer);
      sockets.delete(socket);
    });
    socket.on("error", () => {});
    void (async () => {
      const challenge = randomBytes(32).toString("hex");
      send(socket, { challenge });
      for await (const raw of frames(socket)) {
        const request = JSON.parse(authenticated(secret, challenge, raw)) as OwnershipRequest;
        if (
          request.version !== 1 ||
          !["inspect", "prepare", "commit", "status"].includes(request.action) ||
          typeof request.operation !== "string" ||
          !/^[a-f0-9]{32}$/.test(request.operation) ||
          typeof request.identity !== "string" ||
          request.identity.length > 4096
        )
          throw new Error("invalid_request");
        const result = await handle(request);
        send(socket, signed(secret, challenge, { result }));
        socket.end();
        // Drain until peer closes, so async iterator cleanup cannot truncate the response.
      }
    })().catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", () => {});
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("control_unavailable");
  return {
    control: { version: 1, port: address.port, secret },
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
