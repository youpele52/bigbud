/**
 * Test-only agent-proxy and OpenCode handler fragment for the fake owner script.
 *
 * Kept separate so the owner script stays within the file-length limit; it is
 * interpolated into the generated script with the same local helpers in scope.
 *
 * @module sshOwnerProductionClient.fakeOwner.proxy
 */

export const PROXY_HANDLER_SCRIPT = String.raw`// One agent-proxy lease and one OpenCode listener per target. Production owners
// keep the exact target and generation on each; the fake mirrors that identity
// so a client test can prove one target's close never reaches another's lease.
const agentLeases = new Map();
const agentClosed = new Set();
const agentStatus = (lease, closed) =>
  Buffer.concat([
    bytesField(1, lease),
    uintField(2, 4242),
    uintField(3, closed ? 1 : 0),
    closed ? uintField(4, 0) : Buffer.alloc(0),
  ]);
const agentLease = (target) => {
  if (!agentLeases.has(target)) {
    const lease = Buffer.alloc(32, 0);
    lease.writeUInt8(0x50 + agentLeases.size, 0);
    lease.write(target.slice(0, 24), 1, "utf8");
    agentLeases.set(target, lease);
  }
  return agentLeases.get(target);
};
const handleAgentProxy = (requestId, target, operation) => {
  const inner = parseFields(operation.value);
  const requested = field(inner, 1) ? field(inner, 1).value : Buffer.alloc(0);
  switch (operation.field) {
    case 29: // open_agent_proxy (owner-selected production binding)
      agentClosed.delete(target);
      return reply(requestId, target, 24, agentStatus(agentLease(target), false));
    case 30: // agent_proxy_status
      if (!agentLeases.has(target) || !requested.equals(agentLease(target)))
        return reply(requestId, target, 10, uintField(1, 2));
      return reply(requestId, target, 24, agentStatus(agentLease(target), agentClosed.has(target)));
    case 31: // close_agent_proxy
      if (!agentLeases.has(target) || !requested.equals(agentLease(target)))
        return reply(requestId, target, 10, uintField(1, 2));
      agentClosed.add(target);
      return reply(requestId, target, 24, agentStatus(agentLease(target), true));
    default:
      return reply(requestId, target, 10, uintField(1, 2));
  }
};
const opencodeLeases = new Map();
let nextOpencodePort = 41000;
const opencodeState = (lease, phase, port) =>
  Buffer.concat([
    bytesField(1, lease),
    uintField(2, phase),
    port === undefined ? Buffer.alloc(0) : uintField(3, port),
  ]);
const handleOpencode = (requestId, target, operation) => {
  const inner = parseFields(operation.value);
  const known = opencodeLeases.get(target);
  if (operation.field === 50) {
    const lease = field(inner, 2) ? field(inner, 2).value : Buffer.alloc(0);
    if (lease.length !== 32) return reply(requestId, target, 10, uintField(1, 3));
    const port = nextOpencodePort++;
    opencodeLeases.set(target, { lease, port });
    return reply(requestId, target, 33, opencodeState(lease, 2, port));
  }
  const requested = field(inner, 1) ? field(inner, 1).value : Buffer.alloc(0);
  if (!known || !requested.equals(known.lease))
    return reply(requestId, target, 10, uintField(1, 2));
  if (operation.field === 51)
    return reply(requestId, target, 33, opencodeState(known.lease, 2, known.port));
  opencodeLeases.delete(target);
  return reply(requestId, target, 33, opencodeState(known.lease, 4));
};
`;
