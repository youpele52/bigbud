import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";
import { Effect, Layer } from "effect";

import {
  OpencodeServerManager,
  type OpencodeServerHandle,
} from "../Services/OpencodeServerManager.ts";

/**
 * Manages a single shared OpenCode server process.
 *
 * The server is started lazily on the first `acquire()` call.
 * Each caller gets a handle; when all handles are released, the server is stopped.
 * Concurrent `acquire()` calls while the server is starting will all wait for
 * the same start promise.
 */
function makeOpencodeServerManager(): { acquire: () => Promise<OpencodeServerHandle> } {
  let refCount = 0;
  let startPromise: Promise<{ url: string; close: () => void }> | null = null;
  let serverHandle: { url: string; close: () => void } | null = null;

  const acquire = async (): Promise<OpencodeServerHandle> => {
    // If a server is already running, reuse it
    if (serverHandle !== null) {
      refCount++;
      const url = serverHandle.url;
      const client = createOpencodeClient({ baseUrl: url });
      return makeHandle(client, url);
    }

    // If a start is in flight, wait for it
    if (startPromise === null) {
      startPromise = createOpencode({ port: 0 })
        .then(({ client: _client, server }) => ({
          url: server.url,
          close: () => server.close(),
        }))
        .catch((err) => {
          // Clear startPromise so subsequent acquire() calls can retry
          // instead of awaiting a permanently-rejected promise.
          startPromise = null;
          console.error("[opencode-server-manager] Failed to start OpenCode server:", err);
          throw err;
        });
    }

    const handle = await startPromise;
    serverHandle = handle;
    startPromise = null;
    refCount++;

    const client = createOpencodeClient({ baseUrl: handle.url });
    return makeHandle(client, handle.url);
  };

  function makeHandle(
    client: ReturnType<typeof createOpencodeClient>,
    url: string,
  ): OpencodeServerHandle {
    let released = false;
    return {
      client,
      url,
      release() {
        if (released) return;
        released = true;
        refCount--;
        if (refCount <= 0 && serverHandle !== null) {
          serverHandle.close();
          serverHandle = null;
          refCount = 0;
        }
      },
    };
  }

  return { acquire };
}

export const OpencodeServerManagerLive = Layer.effect(
  OpencodeServerManager,
  Effect.sync(() => makeOpencodeServerManager()),
);
