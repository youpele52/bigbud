import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { runWithAbortableDeadline } from "../../RequestDeadline.ts";

export type V2ThreadCallback = (body: unknown, signal: AbortSignal) => Promise<unknown>;

/** One bounded owned IPv4 callback listener; it never accepts native credentials or CORS authority. */
export async function openV2ThreadTransport(invoke: V2ThreadCallback) {
  const sockets = new Set<Socket>();
  const headerDeadlines = new Map<Socket, ReturnType<typeof setTimeout>>();
  const socketRequests = new Map<Socket, number>();
  const controllers = new Set<AbortController>();
  let active = 0;
  const server = createServer(
    {
      maxHeaderSize: 8192,
      headersTimeout: 5000,
      requestTimeout: 5000,
      keepAliveTimeout: 5000,
      connectionsCheckingInterval: 1000,
    },
    (request, response) => {
      void handle(request, response);
    },
  );
  server.on("connection", (socket) => {
    if (sockets.size >= 64) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    headerDeadlines.set(
      socket,
      setTimeout(() => socket.destroy(), 5000),
    );
    socket.once("close", () => {
      sockets.delete(socket);
      clearTimeout(headerDeadlines.get(socket));
      headerDeadlines.delete(socket);
      socketRequests.delete(socket);
    });
  });
  server.on("clientError", (_error, socket) => socket.destroy());

  async function handle(request: IncomingMessage, response: ServerResponse) {
    clearTimeout(headerDeadlines.get(request.socket));
    headerDeadlines.delete(request.socket);
    socketRequests.set(request.socket, (socketRequests.get(request.socket) ?? 0) + 1);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (request.socket.destroyed) {
        socketRequests.delete(request.socket);
        clearTimeout(headerDeadlines.get(request.socket));
        headerDeadlines.delete(request.socket);
        return;
      }
      const remaining = Math.max(0, (socketRequests.get(request.socket) ?? 1) - 1);
      socketRequests.set(request.socket, remaining);
      if (!remaining && !request.socket.destroyed) {
        clearTimeout(headerDeadlines.get(request.socket));
        headerDeadlines.set(
          request.socket,
          setTimeout(() => request.socket.destroy(), 5000),
        );
      }
    };
    response.once("finish", finish);
    response.once("close", finish);
    const refuse = (status: number) => {
      response
        .writeHead(status, { "content-type": "application/json", connection: "close" })
        .end('{"error":"Required bigbud thread-tools invocation rejected."}');
    };
    if (
      request.method !== "POST" ||
      request.url !== "/invoke" ||
      request.headers["content-type"] !== "application/json" ||
      request.headers.origin !== undefined ||
      request.headers.authorization !== undefined
    ) {
      refuse(403);
      return;
    }
    if (active >= 32) {
      refuse(429);
      return;
    }
    const contentLength = request.headers["content-length"];
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > 32768)) {
      refuse(413);
      return;
    }
    active++;
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort();
    request.once("aborted", abort);
    response.once("close", () => {
      if (!response.writableFinished) abort();
    });
    const readTimer = setTimeout(() => {
      abort();
      request.destroy();
    }, 5000);
    const overallTimer = setTimeout(abort, 300000);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        controller.signal.throwIfAborted();
        size += Buffer.byteLength(chunk);
        if (size > 32768) {
          refuse(413);
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      clearTimeout(readTimer);
      const body = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
      const result = await runWithAbortableDeadline({
        operation: "V2 thread-tools callback",
        timeoutMs: 300000,
        signal: controller.signal,
        run: (signal) => invoke(body, signal),
      });
      controller.signal.throwIfAborted();
      const text = JSON.stringify(result);
      if (text === undefined || Buffer.byteLength(text) > 131072) throw new Error("response bound");
      response.writeHead(200, { "content-type": "application/json" }).end(text);
    } catch {
      // Native exceptions/request contents are deliberately not logged or serialized.
      if (!response.headersSent && !response.destroyed) refuse(403);
    } finally {
      clearTimeout(readTimer);
      clearTimeout(overallTimer);
      request.removeListener("aborted", abort);
      controllers.delete(controller);
      active--;
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("V2 thread-tools callback listener unavailable.");
  return {
    url: `http://127.0.0.1:${address.port}/invoke`,
    async close() {
      for (const controller of controllers) controller.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
