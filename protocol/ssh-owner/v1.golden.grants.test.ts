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
