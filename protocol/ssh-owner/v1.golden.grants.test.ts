import assert from "node:assert/strict";
import { test } from "vitest";

import { goldens } from "./v1.golden.codec.ts";

/**
 * Every positive request frame has a canonical grant digest. A grant is bound
 * to exactly one operation digest, so distinct role vectors prove that a
 * monitor, read, PTY, thread, provider, ACP or peer grant cannot be
 * substituted for another role.
 */
const crossRoleVectors = [
  ["proof_health_request", "proof_terminal_open", "monitor -> PTY"],
  ["proof_workspace_preview", "proof_write_request", "read -> write"],
  ["proof_run_thread_shell", "proof_run_acp_command", "thread -> ACP"],
  ["proof_run_provider_workspace_shell", "proof_run_thread_shell", "provider -> thread"],
  ["inspect_trust", "proof_peer_relay_open", "ordinary trust -> peer"],
  ["inspect_trust", "proof_inspect_peer_host_key", "ordinary trust -> peer enrollment"],
  ["proof_health_request", "proof_ensure_peer_coordinator_key", "monitor -> peer key"],
  ["proof_inspect_peer_host_key", "proof_terminal_open", "peer enrollment -> PTY"],
] as const;

test("cross-role grant vectors are distinct and cannot be substituted", () => {
  const digests = goldens("v1.golden.grants");
  for (const [left, right, label] of crossRoleVectors) {
    const leftDigest = digests.get(left);
    const rightDigest = digests.get(right);
    assert.ok(leftDigest, `${label}: missing ${left}`);
    assert.ok(rightDigest, `${label}: missing ${right}`);
    assert.notEqual(leftDigest, rightDigest, `${label}: grants share one digest`);
  }
});

/**
 * W2 T-shell production leases: thread, provider and ACP opens are three
 * distinct grants, never shared with their proof counterparts, a PTY, a read,
 * a monitor or ordinary trust; lease status and close are separate grants too.
 */
test("production exec grants are distinct across roles and from proof and PTY grants", () => {
  const digests = goldens("v1.golden.grants");
  const production = [
    "run_thread_shell",
    "run_provider_workspace_shell",
    "run_acp_command",
    "shell_status",
    "shell_close",
    "run_acp_shell",
  ] as const;
  const others = [
    "proof_run_thread_shell",
    "proof_run_provider_workspace_shell",
    "proof_run_acp_command",
    "proof_terminal_open",
    "proof_terminal_input",
    "proof_workspace_preview",
    "proof_write_request",
    "proof_health_request",
    "inspect_trust",
    "git_upload_open",
  ] as const;
  const values = production.map((name) => {
    const digest = digests.get(name);
    assert.ok(digest, name);
    return digest;
  });
  assert.equal(new Set(values).size, production.length, "production exec grants collide");
  for (const name of others) {
    const digest = digests.get(name);
    assert.ok(digest, name);
    assert.ok(!values.includes(digest), `${name} shares a production exec grant`);
  }
});

test("exec-class grants are pairwise distinct", () => {
  const digests = goldens("v1.golden.grants");
  const exec = [
    "proof_run_thread_shell",
    "proof_run_provider_workspace_shell",
    "proof_run_acp_command",
  ] as const;
  const values = exec.map((name) => {
    const digest = digests.get(name);
    assert.ok(digest, name);
    return digest;
  });
  assert.equal(new Set(values).size, exec.length);
});

/**
 * C15 / W2 T-xfer. The reserved transfer verbs are fixture-only in S1-S4, and
 * their operand digests never coincide with a PTY, shell, peer or
 * ordinary-trust grant. Distinct digests are what make substitution refusals
 * hold across roles; the exact values are pinned by the Rust verifier.
 */
test("reserved transfer grants share no digest with PTY, shell, peer or trust", () => {
  const digests = goldens("v1.golden.grants");
  for (const [left, right, label] of [
    ["proof_transfer_stream", "proof_terminal_open", "transfer -> PTY"],
    ["proof_transfer_stream", "proof_run_thread_shell", "transfer -> thread shell"],
    ["proof_transfer_stream", "proof_peer_relay_open", "transfer -> peer relay"],
    ["proof_packaged_rsync", "proof_terminal_open", "packaged rsync -> PTY"],
    [
      "proof_packaged_rsync",
      "proof_run_provider_workspace_shell",
      "packaged rsync -> provider shell",
    ],
    ["proof_packaged_rsync", "proof_peer_relay_open", "packaged rsync -> peer relay"],
    ["inspect_trust", "proof_transfer_stream", "ordinary trust -> transfer"],
    ["inspect_trust", "proof_packaged_rsync", "ordinary trust -> packaged rsync"],
    ["proof_transfer_stream", "proof_packaged_rsync", "transfer -> packaged rsync"],
  ] as const) {
    const leftDigest = digests.get(left);
    const rightDigest = digests.get(right);
    assert.ok(leftDigest, `${label}: missing ${left}`);
    assert.ok(rightDigest, `${label}: missing ${right}`);
    assert.notEqual(leftDigest, rightDigest, `${label}: grants share one digest`);
  }
});

/**
 * U24 production peer grants: owner-held pin approval, revocation and relay are
 * each their own grant and never coincide with ordinary trust, the proof peer
 * verbs or one another.
 */
test("production peer grants are distinct from trust, proof peer verbs and each other", () => {
  const digests = goldens("v1.golden.grants");
  const production = [
    "ensure_peer_coordinator_key",
    "inspect_peer_host_key",
    "inspect_peer_host_key_other_port",
    "approve_peer_pin",
    "revoke_peer_pin",
    "peer_relay_open",
    "peer_relay_status",
    "peer_relay_close",
  ] as const;
  const others = [
    "inspect_trust",
    "approve_trust",
    "connect",
    "proof_ensure_peer_coordinator_key",
    "proof_inspect_peer_host_key",
    "proof_peer_relay_open",
    "client_relay_lease_open",
  ] as const;
  const seen = new Set<string>();
  for (const name of [...production, ...others]) {
    const digest = digests.get(name);
    assert.ok(digest, `missing ${name}`);
    assert.ok(!seen.has(digest), `${name} shares a grant digest`);
    seen.add(digest);
  }
});
