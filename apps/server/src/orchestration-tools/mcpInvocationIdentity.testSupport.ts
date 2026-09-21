import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";

export type JsonObject = Record<string, unknown>;

export interface BridgeProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly send: (message: JsonObject) => Promise<JsonObject>;
  readonly close: () => Promise<void>;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

export function toolRequest(id: string | number, marker: string, metadataId?: string): JsonObject {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "create_thread",
      arguments: { title: marker, task: `task-${marker}` },
      ...(metadataId ? { _meta: { "bigbud/toolInvocationId": metadataId } } : {}),
    },
  };
}

export function remoteToolRequest(id: string | number, marker: string): JsonObject {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "bash", arguments: { command: `printf ${marker}` } },
  };
}

export function spawnBridge(source: string): BridgeProcess {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source]);
  const queued: JsonObject[] = [];
  const waiters: Array<(message: JsonObject) => void> = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as JsonObject;
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else queued.push(message);
    }
  });

  const nextMessage = () => {
    const message = queued.shift();
    if (message) return Promise.resolve(message);
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for bridge response.")),
        5_000,
      );
      waiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  };

  return {
    child,
    send: (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return nextMessage();
    },
    close: async () => {
      if (child.exitCode !== null) return;
      child.stdin.end();
      await once(child, "exit");
    },
  };
}

export async function createInvocationFixture(
  handler: (body: JsonObject) => Promise<JsonObject> = async () => ({ result: {} }),
): Promise<{
  readonly port: number;
  readonly requests: JsonObject[];
  readonly server: Server;
  readonly close: () => Promise<void>;
}> {
  const requests: JsonObject[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as JsonObject;
    requests.push(body);
    const payload = await handler(body);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(payload));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port.");
  return {
    port: address.port,
    requests,
    server,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
