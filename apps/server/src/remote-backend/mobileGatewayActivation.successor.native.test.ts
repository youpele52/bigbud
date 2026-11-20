import { expect, it, vi } from "vitest";
import { MOBILE_GATEWAY_CREDENTIAL_ENV } from "@bigbud/shared/mobileGatewaySupervisor.config";
import { connectNativeServiceLeaseClient } from "../remote-agent/remoteAgentServiceLeaseClient.ts";
import {
  retainedReference,
  stateDir,
} from "../remote-agent/remoteAgentServiceLease.test.fixture.ts";
import {
  exitedReply,
  refusedReply,
  successorCredential,
  successorFixture,
} from "../remote-agent/remoteAgentServiceLease.successor.fixture.ts";
import { runMobileSuccessorRecovery } from "./mobileGatewayActivation.successor.ts";
import {
  mobileGatewayBootstrapCredential,
  nativeMobileSuccessorPort,
} from "./mobileGatewayActivation.successor.native.ts";
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readFile: async (path: string) => {
      if (path === `/proc/${process.pid}/stat`)
        return `${process.pid} (node) ${["S", ...Array<string>(18).fill("0"), "123"].join(" ")}`;
      if (path === "/proc/sys/kernel/random/boot_id") return "fixture-boot\n";
      throw Error("Unexpected synthetic controller fixture read.");
    },
  };
});

/** Actual owner client over scripted native replies; the socket and journal are recorded only. */
async function recover(script: Parameters<typeof successorFixture>[0], consent: boolean[] = []) {
  const f = successorFixture(script);
  const client = await connectNativeServiceLeaseClient(f.connection, {
    nativeEpoch: "epoch",
    stateDir,
  });
  const events: string[] = [];
  try {
    const outcome = await runMobileSuccessorRecovery({
      native: nativeMobileSuccessorPort(client, client.restorePending(retainedReference(f.input))),
      signal: new AbortController().signal,
      consented: async () => consent.shift() ?? true,
      serveUpstream: async (credential) => {
        events.push(`serve:${credential === successorCredential}`);
        return { release: async () => void events.push("release") };
      },
      recordExit: async () => void events.push("record-exit"),
    });
    return { outcome, events, wire: f.sent() };
  } finally {
    await client.dispose();
  }
}

it("wires Resume #1 attaching, the bootstrap credential and Resume #2 spawned to readiness", async () => {
  const result = await recover({ resume: [{}, { state: "spawned" }] });
  expect(result.outcome.kind).toBe("ready");
  expect(result.events).toEqual(["serve:true"]);
  expect(result.wire).toEqual(["resume", "resume"]);
});

it("wires legacy spawned, still-attaching, gone and revoked native replies honestly", async () => {
  const legacy = await recover({ resume: [{ state: "spawned" }] });
  expect(legacy.outcome).toEqual({ kind: "uncertain", reason: "legacy-native" });
  expect(legacy.events).toEqual([]);
  const absent = await recover({ resume: [{}, {}] });
  expect(absent.outcome).toEqual({ kind: "unready" });
  expect(absent.events).toEqual(["serve:true", "release"]);
  const gone = await recover({ resume: [refusedReply], status: [exitedReply] });
  expect(gone.outcome).toEqual({ kind: "exited" });
  expect(gone.events).toEqual(["record-exit"]);
  expect(gone.wire).toEqual(["resume", "status"]);
  const uncertain = await recover({ resume: [{}, refusedReply], status: [{}] });
  expect(uncertain.outcome).toEqual({ kind: "uncertain", reason: "native-unsettled" });
  expect(uncertain.wire).not.toContain("stop-original");
  const revoked = await recover({ resume: [{}], control: [exitedReply] }, [true, true, false]);
  expect(revoked.outcome).toEqual({ kind: "revoked" });
  expect(revoked.events).toEqual(["serve:true", "record-exit", "release"]);
  expect(revoked.wire).toEqual(["resume", "stop-original"]);
});

it("extracts exactly one visible-ASCII gateway credential from the private bootstrap", () => {
  const value = "v".repeat(32);
  expect(
    mobileGatewayBootstrapCredential([
      { name: "PATH", value: "/usr/bin" },
      { name: MOBILE_GATEWAY_CREDENTIAL_ENV, value },
    ]),
  ).toBe(value);
  for (const environment of [
    [],
    [{ name: MOBILE_GATEWAY_CREDENTIAL_ENV, value: "short" }],
    [{ name: MOBILE_GATEWAY_CREDENTIAL_ENV, value: `${value} ` }],
    [
      { name: MOBILE_GATEWAY_CREDENTIAL_ENV, value },
      { name: MOBILE_GATEWAY_CREDENTIAL_ENV, value },
    ],
  ])
    expect(() => mobileGatewayBootstrapCredential(environment)).toThrow(/credential/);
});
