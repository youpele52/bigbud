import { get } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await predicate()) return;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

export async function waitForHttp(url: string): Promise<void> {
  await waitFor(
    async () => {
      try {
        return await new Promise<boolean>((resolve, reject) => {
          const request = get(url, (response) => {
            response.resume();
            resolve(response.statusCode === 200);
          });
          request.setTimeout(1000, () => request.destroy(new Error("HTTP timeout")));
          request.once("error", reject);
        });
      } catch {
        return false;
      }
    },
    "packaged backend HTTP readiness",
    45_000,
  );
}

export async function openRpcSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", failed);
    };
    const opened = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      socket.close();
      reject(new Error("WebSocket open failed"));
    };
    const timer = setTimeout(failed, 5000);
    socket.addEventListener("open", opened, { once: true });
    socket.addEventListener("error", failed, { once: true });
  });
  return socket;
}

let sequence = 0;
export function requestRpc<T = unknown>(
  socket: WebSocket,
  tag: string,
  payload: unknown = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = String(++sequence);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", receive);
      socket.removeEventListener("close", closed);
      socket.removeEventListener("error", closed);
    };
    const closed = () => {
      cleanup();
      reject(new Error(`Socket closed during ${tag}`));
    };
    const receive = (event: MessageEvent) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message._tag !== "Exit" || message.requestId !== id) return;
      cleanup();
      if (message.exit?._tag === "Success") resolve(message.exit.value as T);
      else reject(new Error(`RPC ${tag}: ${JSON.stringify(message.exit)}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`RPC timeout: ${tag}`));
    }, 5000);
    socket.addEventListener("message", receive);
    socket.addEventListener("close", closed);
    socket.addEventListener("error", closed);
    try {
      socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
