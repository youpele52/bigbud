import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import { assertDecoded, consume, encode, frame, framePayload, goldens } from "./v1.golden.codec.ts";
import { errorCases } from "./v1.golden.errors.ts";

const source = readFileSync(new URL("v1.proto", import.meta.url), "utf8");
const verbs = readFileSync(new URL("v1.golden.verbs", import.meta.url), "utf8");

const declaredOperations = (() => {
  const block = /\boneof operation\s*\{([^}]+)\}/.exec(source)?.[1];
  assert.ok(block, "missing oneof operation");
  return [...block.matchAll(/\b([a-z][a-z0-9_]*)\s*=\s*(\d+)\s*;/g)].map((match) => ({
    name: match[1]!,
    field: Number(match[2]),
  }));
})();

const mapping = (() => {
  const values = new Map<string, string>();
  for (const line of verbs.trimEnd().split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-z][a-z0-9_]*)=([a-z][a-z0-9_]*)$/.exec(line);
    assert.ok(match, line);
    const [, proof, production] = match;
    assert.ok(proof && production && !values.has(proof), line);
    values.set(proof, production);
  }
  return values;
})();

// `terminal_inspect` was allocated as field 120 (W2 T-term).
const reservedFutures = ["subscribe_status", "git_remote_transport"] as const;

test("frozen production verbs cover every proof_* operation exactly once", () => {
  // The product verbs keep their existing names and field numbers.
  assert.deepEqual(
    declaredOperations.filter(({ name }) => !name.startsWith("proof_")),
    [
      { name: "inspect_trust", field: 10 },
      { name: "approve_trust", field: 11 },
      { name: "connect", field: 12 },
      { name: "disconnect", field: 13 },
      { name: "list_folders", field: 14 },
      // W2 T-shell production exec leases (promoted frozen names plus lease control).
      { name: "run_thread_shell", field: 90 },
      { name: "run_provider_workspace_shell", field: 91 },
      { name: "run_acp_command", field: 92 },
      { name: "shell_status", field: 93 },
      { name: "shell_close", field: 94 },
      // U21: approved ACP terminal command (its own grant).
      { name: "run_acp_shell", field: 95 },
      { name: "list_aliases", field: 76 },
      // U15 production Git upload lease (read-only).
      { name: "git_upload_open", field: 77 },
      { name: "git_upload_status", field: 78 },
      { name: "git_upload_close", field: 79 },
      // W2 T-prov production Pi/Codex provider leases.
      { name: "probe_provider", field: 80 },
      { name: "provider_lease_open", field: 81 },
      { name: "provider_lease_status", field: 82 },
      { name: "provider_lease_close", field: 83 },
      // W2 T-backend deployment step and client relay leases.
      { name: "deployment_step_open", field: 100 },
      { name: "deployment_step_status", field: 101 },
      { name: "deployment_step_cancel", field: 102 },
      { name: "client_relay_lease_open", field: 103 },
      { name: "client_relay_lease_status", field: 104 },
      { name: "client_relay_lease_close", field: 105 },
      // U15 production Git receive lease (push), declared after 79.
      { name: "git_receive_open", field: 110 },
      { name: "git_receive_status", field: 111 },
      { name: "git_receive_close", field: 112 },
      // W2 T-term production terminal process snapshot and U16 shell inventory.
      { name: "terminal_inspect", field: 120 },
      { name: "list_terminal_shells", field: 121 },
      // W2 T-files session-FS entry verbs.
      { name: "workspace_entry_info", field: 122 },
      { name: "workspace_rename", field: 123 },
      { name: "workspace_append", field: 124 },
      // U24 production peer enrollment and relay (owner-wide, owner-held pins).
      { name: "ensure_peer_coordinator_key", field: 130 },
      { name: "inspect_peer_host_key", field: 131 },
      { name: "approve_peer_pin", field: 132 },
      { name: "revoke_peer_pin", field: 133 },
      { name: "peer_relay_open", field: 134 },
      { name: "peer_relay_status", field: 135 },
      { name: "peer_relay_close", field: 136 },
      // U25 remote-agent control parity (owner-compiled templates per kind).
      { name: "agent_control_open", field: 140 },
      { name: "agent_control_status", field: 141 },
      { name: "agent_control_cancel", field: 142 },
      { name: "agent_proxy_lease_open", field: 143 },
      { name: "agent_proxy_lease_status", field: 144 },
      { name: "agent_proxy_lease_close", field: 145 },
    ],
  );

  const proofNames = declaredOperations
    .filter(({ name }) => name.startsWith("proof_"))
    .map(({ name }) => name)
    .toSorted();
  assert.deepEqual([...mapping.keys()].toSorted(), proofNames);

  const productionNames = [...mapping.values()];
  assert.equal(new Set(productionNames).size, productionNames.length);
  for (const [proof, production] of mapping) {
    assert.match(production, /^[a-z][a-z0-9_]*$/, proof);
    assert.ok(!production.startsWith("proof_"), proof);
    assert.ok(!proofNames.includes(production), proof);
  }
});

test("every declared operation field number is unique", () => {
  const fields = declaredOperations.map(({ field }) => field);
  assert.equal(new Set(fields).size, fields.length);
  // 127 stays the permanent unknown-variant sentinel. U24 (peer enrollment and
  // relay) was allocated 130–136 above it; protobuf's 19000–19999 stays unused.
  assert.ok(fields.every((field) => field >= 10 && field !== 127 && field < 19_000));
});

test("reserved future production names are recorded and remain unallocated", () => {
  const section = /Reserved future production names[^:]*:([\s\S]*)$/.exec(
    source.slice(0, source.indexOf("oneof operation")),
  )?.[1];
  assert.ok(section, "missing reserved future names");
  const documented = new Set(
    [...section.matchAll(/\b([a-z][a-z0-9_]*)\b/g)].map((match) => match[1]!),
  );
  for (const name of reservedFutures) assert.ok(documented.has(name), name);
  const allocated = new Set([...mapping.values(), ...declaredOperations.map(({ name }) => name)]);
  for (const name of reservedFutures) assert.ok(!allocated.has(name), name);
});

test("the three additive typed-error frames match the ErrorCode values", () => {
  const values = goldens("v1.golden.frames");
  // The cases encode ErrorCode 28, 29 and 30; see `v1.golden.errors.ts`.
  for (const name of [
    "error_session_quota",
    "error_windows_password_unsupported",
    "error_keyboard_interactive_unsupported",
  ] as const) {
    const fields = errorCases[name];
    const expected = consume(values, name);
    assert.deepEqual(frame(encode(fields)), expected, name);
    assertDecoded(framePayload(expected), fields);
  }
});
