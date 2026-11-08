import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { vi } from "vitest";
import { makeV2RetainedActivationFixture } from "./PluginSetup.activation.retained.fixture.ts";
import { sharedServiceTestRegistration } from "./SharedService.test.fixture.ts";
import { readV2SharedRegistration, v2SharedGeneration } from "./SharedService.registration.ts";
import { bindV2NativeCompatibility } from "./NativeCompatibility.binding.ts";
import { v2CanonicalApiFixture } from "./NativeCompatibility.api.fixture.ts";
import { verifyV2NativeEligibility } from "./NativeCompatibility.runtime.ts";
import { runV2RequestContext } from "./Client.guard.ts";
import { V2ActivationRecovery } from "./PluginSetup.activation.recovery.ts";
import { V2ActivationGate } from "./PluginSetup.activation.gate.ts";
import { runV2ActivationTransaction } from "./PluginSetup.activation.transaction.ts";
import { readV2ActivationIdle } from "./PluginSetup.activation.activity.ts";
import type { V2OwnedActivationJob } from "./PluginSetup.activation.jobs.ts";
import { writeV2OwnerMarker, type V2BackendInstance } from "./Orchestration.instances.ts";
import {
  decodeV2EnrollmentRecord,
  digestV2EnrollmentOwner,
} from "./Orchestration.enrollment.record.ts";
import { V2EnrollmentRetirement } from "./Orchestration.enrollment.retirement.ts";
import { makeV2ThreadPluginHost } from "./Orchestration.plugin.host.fixture.ts";

/** Production proof and real signed v3/v4 plugin handlers; only native HTTP/state is synthetic. */
export async function makeV2RecoveryProofFixture() {
  const f = await makeV2RetainedActivationFixture("2.2.6");
  const registration = await sharedServiceTestRegistration({ version: "2.2.6" });
  const native = await readV2SharedRegistration(registration.file);
  const descriptor = {
    registrationFile: registration.file,
    generation: v2SharedGeneration(native),
    storageIdentity: f.owner.storageIdentity,
  };
  let generationCurrent = true;
  bindV2NativeCompatibility(f.client, {
    descriptor,
    assertCurrent: () => {
      if (!generationCurrent) throw new Error("V2 fixture native generation changed");
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const route = new URL(String(input)).pathname;
      if (!["/api/info", "/openapi.json"].includes(route))
        throw new Error("Unexpected fixture health request");
      return Response.json(
        route === "/api/info"
          ? { version: native.version, pid: native.pid }
          : v2CanonicalApiFixture(),
      );
    }),
  );
  const backend: V2BackendInstance = {
    nonce: randomBytes(16).toString("hex"),
    pid: process.pid,
    startedAt: null,
    hostname: "fixture",
    stateDir: f.app.root,
    assertHeld: vi.fn(async () => {}),
    classifyOwner: vi.fn(() => "dead" as const),
  };
  const second = {
    ...f.owner,
    nativeSessionId: "second-native",
    threadId: "second-thread",
    directory: `${f.root}/second`,
    enrollmentNonce: "e".repeat(32),
  };
  const retirement = await V2EnrollmentRetirement.open(f.enrollments);
  const identities = [];
  for (const owner of [f.owner, second]) {
    const digest = digestV2EnrollmentOwner(owner);
    const identity = {
      wireProtocol: owner.protocol,
      ownerDigest: digest,
      enrollmentNonce: owner.enrollmentNonce,
      directory: owner.directory,
      nativeSessionId: owner.nativeSessionId,
    };
    identities.push(identity);
    await writeV2OwnerMarker(
      f.enrollments,
      { ...backend, nonce: "d".repeat(32), pid: 12345 },
      digest,
      owner.enrollmentNonce,
    );
    if (owner === second) {
      await f.enrollments.replace("second", undefined, {
        owner,
        digest,
        state: "revoked",
        acknowledged: { revision: 1, expiry: 1 },
        pending: { revision: 2, expiry: 2 },
      });
      await retirement.begin(identity, (await f.enrollments.read("second"))!);
    } else {
      const saved = (await f.enrollments.read("retained-owner"))!;
      await f.enrollments.replace("retained-owner", saved.revision, {
        ...decodeV2EnrollmentRecord(saved.value),
        pending: { revision: 2, expiry: Date.now() + 20000 },
      });
    }
  }
  f.client.session.active = vi.fn(async () => ({}));
  Object.assign(f.client, {
    debug: { location: { list: async () => [] } },
    shell: { list: async () => [] },
  });
  const controller = new AbortController();
  const gate = new V2ActivationGate(
    JSON.stringify([f.root, f.app.artifact.issuer, registration.file, descriptor.generation]),
    f.app.artifact.artifactDigest,
    () => {},
  );
  const proposal = {
    artifact: f.app.artifact,
    directories: new Set([f.root]),
    scope: { gate, participants: new Map() },
  };
  const job = {
    id: "proof-recovery",
    signal: controller.signal,
    assertCurrent: () => {
      f.permit.assertCurrent();
      controller.signal.throwIfAborted();
    },
    connection: { client: f.client },
    phase: vi.fn(),
    installed: vi.fn(),
    scope: {
      digest: f.app.artifact.artifactDigest,
      root: f.root,
      transport: registration.file,
      descriptor,
    },
  } as unknown as V2OwnedActivationJob;
  let dispose: (() => Promise<void>) | undefined;
  const oldRpc = f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async (input) => {
    if (input.method === "info" && (await readFile(f.filename, "utf8")) !== f.entry.content) {
      const host = makeV2ThreadPluginHost(f.app.bind("new-native", f.root));
      host.context.app.version = native.version;
      dispose ??= await (await import(f.app.artifact.entryUri)).default.setup(host.context);
      f.rpc.mockImplementation(async (request) => ({
        output: await host.call(request.method, request.input),
      }));
      return { output: await host.call(input.method, input.input) };
    }
    return oldRpc(input);
  });
  return {
    f,
    job,
    backend,
    controller,
    identities,
    retirement,
    loseGeneration: () => {
      generationCurrent = false;
    },
    run: () =>
      runV2RequestContext(
        { permit: f.permit, transport: registration.file, intent: "execute" },
        () =>
          runV2ActivationTransaction(
            job,
            proposal,
            f.f.settings,
            f.coordinator.consent,
            (signal) => readV2ActivationIdle(job, proposal, signal),
            verifyV2NativeEligibility,
            new V2ActivationRecovery(backend),
          ),
      ),
    async close() {
      await dispose?.();
      vi.unstubAllGlobals();
      await registration.close();
      await f.close();
    },
  };
}
