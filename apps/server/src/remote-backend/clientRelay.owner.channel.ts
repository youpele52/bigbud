import { PassThrough, type Duplex } from "node:stream";
import { ClientRelayStdioSocket } from "./clientRelay.stdio.ts";

/** Synchronous Agent socket with bounded queues while the private SSH owner opens asynchronously. */
export function openClientRelaySocket(open: (signal: AbortSignal) => Promise<Duplex>) {
  const controller = new AbortController();
  const incoming = new PassThrough({ highWaterMark: 64 * 1024 });
  const outgoing = new PassThrough({ highWaterMark: 64 * 1024 });
  const socket = new ClientRelayStdioSocket(incoming, outgoing);
  let channel: Duplex | undefined;
  socket.once("close", () => {
    controller.abort();
    channel?.destroy();
  });
  void Promise.resolve()
    .then(() => {
      controller.signal.throwIfAborted();
      return open(controller.signal);
    })
    .then((peer) => {
      if (controller.signal.aborted) {
        peer.destroy();
        return;
      }
      channel = peer;
      peer.once("error", () => socket.destroy(new Error("Backend relay channel failed.")));
      peer.once("close", () => socket.destroy());
      outgoing.pipe(peer).pipe(incoming);
    })
    .catch(() => socket.destroy(new Error("Backend relay channel unavailable.")));
  return socket;
}
