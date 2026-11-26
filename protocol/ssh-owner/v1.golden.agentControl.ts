import type { Message } from "./v1.golden.codec.ts";

const SHA = "5e17".repeat(16);
const ROOT = "/home/bbdev/.bigbud/agent";
const STATE = `${ROOT}/runtimes/g-5e17`;

/** A managed registry runtime in the canonical layout. */
const runtime: Message = [
  [1, "g-5e17"],
  [2, "0.9.0"],
  [3, SHA],
  [4, "build:5e17"],
  [5, "aarch64-unknown-linux-gnu"],
  [6, `${ROOT}/bin/0.9.0/${SHA}/bigbud-remote-agent`],
  [7, STATE],
  [8, `${STATE}/supervisor.sock`],
  [9, `${STATE}/supervisor.log`],
  [10, 1],
];

/**
 * U25 remote-agent control parity (Request 140–145, Reply 81–82; no new ErrorCode). A lease names
 * one kind and data operands only; the owner compiles the template generated from the legacy
 * builder. Streamed kinds (registry CAS, install upload) carry identity only, and their bytes
 * travel on the lease socket.
 */
export function agentControlWireCases(
  request: (tag: number, body: Message) => Message,
  reply: (tag: number, body: Message) => Message,
): Record<string, Message> {
  const lease = new Uint8Array(32).fill(0x25);
  const proxy = new Uint8Array(32).fill(0x26);
  return {
    agent_control_open: request(140, [
      [1, lease],
      [2, 6],
      [3, runtime],
      [4, 5],
      [5, "launch-g-5e17"],
    ]),
    agent_control_open_registry_cas: request(140, [
      [1, lease],
      [2, 3],
      [15, true],
      [16, 512],
      [17, SHA],
      [18, 640],
      [19, SHA],
    ]),
    agent_control_open_install_upload: request(140, [
      [1, lease],
      [2, 25],
      [9, "stage-5e17"],
      [11, "0.9.0"],
      [12, SHA],
      [13, 4_194_304],
    ]),
    agent_control_status: request(141, [[1, lease]]),
    agent_control_cancel: request(142, [[1, lease]]),
    agent_control_listening: reply(81, [
      [1, lease],
      [2, 1],
      [3, 25],
      [4, "/tmp/bigbud-agent-control/s"],
    ]),
    agent_control_exited: reply(81, [
      [1, lease],
      [2, 3],
      [3, 6],
      [5, 0],
      [6, "ready"],
    ]),
    agent_proxy_lease_open: request(143, [
      [1, proxy],
      [2, runtime],
    ]),
    agent_proxy_lease_status: request(144, [[1, proxy]]),
    agent_proxy_lease_close: request(145, [[1, proxy]]),
    agent_proxy_lease_listening: reply(82, [
      [1, proxy],
      [2, 1],
      [3, "/tmp/bigbud-agent-proxy/s"],
    ]),
    agent_proxy_lease_exited: reply(82, [
      [1, proxy],
      [2, 3],
      [4, 0],
    ]),
    agent_control_outcome_unknown: reply(81, [
      [1, lease],
      [2, 5],
      [3, 3],
    ]),
  };
}
