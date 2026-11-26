import type { Message } from "./v1.golden.codec.ts";

const KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PAIRING = "5eb1c0de-1111-4222-8333-444455556666";

/**
 * U24 production peer enrollment and relay (Request 130–136, Reply 76–79, ErrorCode 59–62).
 * Pairing authority is the owner's own pin store: inspection returns a one-time challenge, only
 * approval writes a pin, and a relay names nothing but the pairing id. Every verb is its own
 * grant, distinct from ordinary trust (`inspect_trust`/`approve_trust`) and the proof verbs.
 */
export function peerProductionWireCases(
  request: (tag: number, body: Message) => Message,
  reply: (tag: number, body: Message) => Message,
): Record<string, Message> {
  const challenge = new Uint8Array(32).fill(0x24);
  const lease = new Uint8Array(32).fill(0x79);
  const error = (code: number) => reply(10, [[1, code]]);
  return {
    ensure_peer_coordinator_key: request(130, []),
    inspect_peer_host_key: request(131, [
      [1, "w1.example.test"],
      [2, 22],
    ]),
    inspect_peer_host_key_other_port: request(131, [
      [1, "w1.example.test"],
      [2, 2222],
    ]),
    approve_peer_pin: request(132, [
      [1, challenge],
      [2, PAIRING],
      [3, "bbpeer"],
    ]),
    revoke_peer_pin: request(133, [[1, PAIRING]]),
    peer_relay_open: request(134, [
      [1, lease],
      [2, PAIRING],
    ]),
    peer_relay_status: request(135, [[1, lease]]),
    peer_relay_close: request(136, [[1, lease]]),
    peer_coordinator_key: reply(76, [
      [1, `ssh-ed25519 ${KEY}`],
      [2, `sha256:${"1".repeat(64)}`],
      [3, "ssh-ed25519"],
    ]),
    peer_host_key: reply(77, [
      [1, "ssh-ed25519"],
      [2, "SHA256:kmYcvdi2GkPeWxB6XLjrZB8JHsy2Hm8luHMFp9GMvqk"],
      [3, `ssh-ed25519 ${KEY}`],
      [4, challenge],
    ]),
    peer_pin: reply(78, [
      [1, PAIRING],
      [2, "w1.example.test"],
      [3, 22],
      [4, "bbpeer"],
      [5, "SHA256:kmYcvdi2GkPeWxB6XLjrZB8JHsy2Hm8luHMFp9GMvqk"],
      [6, `sha256:${"1".repeat(64)}`],
    ]),
    peer_relay_listening: reply(79, [
      [1, lease],
      [2, 1],
      [3, "/tmp/bigbud-peer-relay/s"],
      [5, PAIRING],
    ]),
    peer_relay_exited: reply(79, [
      [1, lease],
      [2, 3],
      [4, 0],
      [5, PAIRING],
    ]),
    error_peer_key_corrupt: error(59),
    error_peer_pin_unknown: error(60),
    error_peer_pin_mismatch: error(61),
    error_peer_auth_refused: error(62),
  };
}
