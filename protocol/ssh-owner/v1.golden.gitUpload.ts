import type { Message } from "./v1.golden.codec.ts";
import { gitReceiveWireCases } from "./v1.golden.gitReceive.ts";

/**
 * U15 production Git upload lease (Request 77–79, Reply 50), plus the receive
 * lease cases. Paths are owner-validated; the socket path is owner-made.
 */
export function gitUploadWireCases(
  request: (tag: number, body: Message) => Message,
  reply: (tag: number, body: Message) => Message,
) {
  const lease = new Uint8Array(32).fill(93);
  return {
    git_upload_open: request(77, [
      [1, lease],
      [2, "/srv/work"],
      [3, "/srv/work/repo.git"],
    ]),
    git_upload_status: request(78, [[1, lease]]),
    git_upload_close: request(79, [[1, lease]]),
    git_upload_listening: reply(50, [
      [1, lease],
      [2, 1],
      [3, "/tmp/bigbud-oc1-0123456789abcdef/s"],
    ]),
    git_upload_exited: reply(50, [
      [1, lease],
      [2, 3],
      [4, 0],
    ]),
    ...gitReceiveWireCases(request, reply),
  };
}
