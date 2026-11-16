import type { LocalSupervisorServiceConfig } from "./localSupervisorService.config.ts";

export const serviceConfigFixture: LocalSupervisorServiceConfig = {
  expected_installation_fingerprint: `sha256:${"c".repeat(64)}`,
  authority_reservation_sha256: "f".repeat(64),
  version: "1",
  authority: "a".repeat(32),
  home: "/home/service",
  backend_home: "/home/service/.bigbud/backend",
  rust_binary: `/home/service/.bigbud/agent/bin/0.3.3/${"b".repeat(64)}/bigbud-remote-agent`,
  rust_sha256: "b".repeat(64),
  rust_state: "/home/service/.bigbud/agent/runtimes/g1",
  node_binary: "/home/service/node",
  node_sha256: "c".repeat(64),
  backend_entry: "/home/service/backend.mjs",
  backend_sha256: "d".repeat(64),
  receipt_sha256: "e".repeat(64),
  restart: "no",
  launch_attempt: "original",
  prior_epoch: "fresh",
  launch_boot: "12345678-1234-1234-1234-123456789abc",
};
