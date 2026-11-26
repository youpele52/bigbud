import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  readClientRelayLease,
  readDeploymentStep,
  writeBackendLease,
  type BackendLeaseOperation,
} from "./sshOwnerPickerProof.codec.backend.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

const frames = new Map(
  readFileSync(new URL("../../../../protocol/ssh-owner/v1.golden.frames", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.startsWith("#"))
    .map((line) => line.split("=") as [string, string]),
);
const lease = new Uint8Array(32).fill(61);
const relay = new Uint8Array(32).fill(62);
const digest = (char: string) => char.repeat(64);
const requestId = "0123abcd-0123-4abc-8def-0123456789ab";
const install = "1.2.3-aarch64-unknown-linux-gnu-aaaaaaaaaaaaaaaa";

function encode(operation: BackendLeaseOperation): string {
  const writer = new WireWriter();
  writeBackendLease(writer, operation);
  return Buffer.from(writer.finish()).toString("hex");
}

/** Reply body after the outcome tag (61 = ea03, 62 = f203) and a one-byte length. */
function state(name: string, tag: string) {
  const hex = frames.get(name)!;
  return Buffer.from(hex.slice(hex.indexOf(tag) + 6), "hex");
}

describe("W2 T-backend lease codec", () => {
  it("encodes exactly the golden deployment and relay requests", () => {
    const publish = encode({
      kind: "deploymentStepOpen",
      lease,
      step: {
        kind: "publish",
        requestId,
        home: "/home/bbdev",
        installName: install,
        archiveSha256: digest("a"),
        manifestSha256: digest("b"),
        pins: [
          { path: "node/bin/node", sha256: digest("c") },
          { path: "server/dist/bin.mjs", sha256: digest("d") },
          { path: "server/dist/remote-client-relay/r.mjs", sha256: digest("e") },
        ],
      },
    });
    expect(frames.get("deployment_step_open")?.endsWith(publish)).toBe(true);
    const start = encode({
      kind: "deploymentStepOpen",
      lease,
      step: {
        kind: "start",
        home: "/home/bbdev",
        installName: install,
        nodePath: "node/bin/node",
        entryPath: "server/dist/bin.mjs",
        authorityId: "0123456789abcdef0123456789abcdef",
        enableBoot: true,
      },
    });
    expect(frames.get("deployment_step_start")?.endsWith(start)).toBe(true);
    for (const [name, kind] of [
      ["deployment_step_status", "deploymentStepStatus"],
      ["deployment_step_cancel", "deploymentStepCancel"],
    ] as const)
      expect(frames.get(name)?.endsWith(encode({ kind, lease }))).toBe(true);
    const open = encode({
      kind: "clientRelayLeaseOpen",
      lease: relay,
      nodeBinary: "/home/bbdev/.bigbud/backend-graphs/x/graph/node/bin/node",
      nodeSha256: digest("c"),
      helperEntry: "/home/bbdev/.bigbud/backend-graphs/x/graph/server/dist/r.mjs",
      helperSha256: digest("e"),
      authorityId: "0123456789abcdef0123456789abcdef",
    });
    expect(frames.get("client_relay_lease_open")?.endsWith(open)).toBe(true);
    for (const [name, kind] of [
      ["client_relay_lease_status", "clientRelayLeaseStatus"],
      ["client_relay_lease_close", "clientRelayLeaseClose"],
    ] as const)
      expect(frames.get(name)?.endsWith(encode({ kind, lease: relay }))).toBe(true);
  });

  it("decodes the golden step and channel states", () => {
    expect(readDeploymentStep(state("deployment_step_listening", "ea03"))).toMatchObject({
      phase: "listening",
      kind: "manifestPut",
      requestId,
      socketPath: "/tmp/bigbud-oc1-0123456789abcdef/s",
    });
    expect(readDeploymentStep(state("deployment_step_exited", "ea03"))).toMatchObject({
      phase: "exited",
      kind: "probeHost",
      exitCode: 0,
      stdout: "home=/home/bbdev\narch=aarch64\n",
      stderr: "",
    });
    expect(readDeploymentStep(state("deployment_step_unknown", "ea03"))).toMatchObject({
      phase: "outcomeUnknown",
      kind: "setup",
    });
    expect(readClientRelayLease(state("client_relay_lease_listening", "f203"))).toMatchObject({
      phase: "listening",
      socketPath: "/tmp/bigbud-oc1-fedcba9876543210/s",
    });
    expect(readClientRelayLease(state("client_relay_lease_exited", "f203"))).toMatchObject({
      phase: "exited",
      exitCode: 0,
    });
  });

  it("refuses malformed leases, sizes and relay paths before encoding", () => {
    const refused = (operation: BackendLeaseOperation) =>
      expect(() => encode(operation)).toThrow(PickerProofOwnerError);
    refused({ kind: "deploymentStepStatus", lease: new Uint8Array(31) });
    refused({
      kind: "deploymentStepOpen",
      lease,
      step: { kind: "archiveUpload", requestId, maxBytes: 2 * 1024 ** 3 + 1 },
    });
    refused({
      kind: "clientRelayLeaseOpen",
      lease: relay,
      nodeBinary: "relative/node",
      nodeSha256: digest("c"),
      helperEntry: "/x/r.mjs",
      helperSha256: digest("e"),
      authorityId: "0123456789abcdef0123456789abcdef",
    });
  });
});
