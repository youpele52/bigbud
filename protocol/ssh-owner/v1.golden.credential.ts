import type { Message } from "./v1.golden.codec.ts";

/**
 * In-app SSH password and key-passphrase entry (Request 190–193, Reply 106–107,
 * ErrorCode 79–81; v1.credential.proto). No frame carries a secret: the entry socket the
 * owner returns is the only channel for it.
 */
export function credentialWireCases(
  request: (tag: number, body: Message) => Message,
  reply: (tag: number, body: Message) => Message,
) {
  const lease = new Uint8Array(32).fill(0xc1);
  const error = (code: number) => reply(10, [[1, code]]);
  return {
    inspect_credential: request(190, []),
    credential_unlock_open_password: request(191, [
      [1, lease],
      [2, 2],
    ]),
    credential_unlock_open_passphrase: request(191, [
      [1, lease],
      [2, 3],
    ]),
    credential_unlock_commit: request(192, [[1, lease]]),
    credential_lock: request(193, []),
    credential_state_password_locked: reply(106, [
      [1, 2],
      [3, 3],
    ]),
    credential_state_passphrase_unlocked: reply(106, [
      [1, 3],
      [2, 1],
      [3, 3],
      [4, "/home/u/.ssh/id_ed25519"],
    ]),
    credential_unlock_lease: reply(107, [
      [1, lease],
      [2, "/tmp/bigbud-oc1-0123456789abcdef/s"],
    ]),
    error_credential_required: error(79),
    error_credential_rejected: error(80),
    error_credential_attempts_exhausted: error(81),
  };
}
