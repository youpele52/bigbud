import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { makeV2RetainedActivationFixture } from "./PluginSetup.activation.retained.fixture.ts";
import { V2ActivationRecovery } from "./PluginSetup.activation.recovery.ts";
import { writeV2OwnerMarker, type V2BackendInstance } from "./Orchestration.instances.ts";
import { digestV2EnrollmentOwner } from "./Orchestration.enrollment.record.ts";
import { V2EnrollmentRetirement } from "./Orchestration.enrollment.retirement.ts";
import { V2ActivationGate } from "./PluginSetup.activation.gate.ts";
import { runV2ActivationTransaction } from "./PluginSetup.activation.transaction.ts";
import { readV2ActivationIdle } from "./PluginSetup.activation.activity.ts";
import type { V2OwnedActivationJob } from "./PluginSetup.activation.jobs.ts";
import type { OpencodeV2Client } from "./Client.ts";
import { makeV2ThreadPluginHost } from "./Orchestration.plugin.host.fixture.ts";
import { setTimeout as delay } from "node:timers/promises";

vi.mock("./SharedService.connection.ts", () => ({
  borrowV2SharedService: async () => {
    throw new Error("Unexpected native connection");
  },
}));

const identity = (
  owner: Awaited<ReturnType<typeof makeV2RetainedActivationFixture>>["owner"],
  ownerDigest: string,
) => ({
  wireProtocol: owner.protocol,
  ownerDigest,
  enrollmentNonce: owner.enrollmentNonce,
  directory: owner.directory,
  nativeSessionId: owner.nativeSessionId,
});

async function fixture() {
  const f = await makeV2RetainedActivationFixture();
  const backend: V2BackendInstance = {
    nonce: randomBytes(16).toString("hex"),
    pid: process.pid,
    startedAt: null,
    hostname: "fixture",
    stateDir: f.app.root,
    assertHeld: vi.fn(async () => {}),
    classifyOwner: vi.fn(() => "dead" as const),
  };
  const saved = (await f.enrollments.entries())[0]!;
  const digest = digestV2EnrollmentOwner(f.owner);
  await writeV2OwnerMarker(
    f.enrollments,
    { ...backend, nonce: "f".repeat(32), pid: 12345 },
    digest,
    f.owner.enrollmentNonce,
  );
  const second = {
    ...f.owner,
    threadId: "second-thread",
    nativeSessionId: "second-native",
    directory: `${f.root}/second`,
    enrollmentNonce: "e".repeat(32),
  };
  const secondDigest = digestV2EnrollmentOwner(second);
  const secondSaved = await f.enrollments.replace("second", undefined, {
    owner: second,
    digest: secondDigest,
    state: "revoked",
    acknowledged: { revision: 1, expiry: 1 },
    pending: { revision: 2, expiry: 2 },
  });
  await writeV2OwnerMarker(
    f.enrollments,
    { ...backend, nonce: "d".repeat(32), pid: 12346 },
    secondDigest,
    second.enrollmentNonce,
  );
  const retirement = await V2EnrollmentRetirement.open(f.enrollments);
  await retirement.begin(identity(second, secondDigest), secondSaved);
  const calls: string[] = [];
  const rpc = f.rpc;
  rpc.mockImplementation(async (input) => {
    calls.push(input.method);
    if (input.method === "inspect" || input.method === "detach") {
      const envelope = input.input as { ownerDigest: string; enrollmentNonce: string };
      return {
        output: {
          state: input.method === "inspect" ? "missing" : "revoked",
          ownerDigest: envelope.ownerDigest,
          enrollmentNonce: envelope.enrollmentNonce,
          revision: 0,
          expiry: 0,
        },
      };
    }
    return { output: await f.host.call(input.method, input.input) };
  });
  const active = vi.fn(async (): Promise<Record<string, unknown>> => ({}));
  const client = Object.assign(f.client, {
    session: { ...f.client.session, active },
    debug: { location: { list: async () => [] } },
    shell: { list: async () => [] },
  }) as unknown as OpencodeV2Client;
  const controller = new AbortController();
  const gate = new V2ActivationGate(
    JSON.stringify([
      f.root,
      f.app.artifact.issuer,
      f.descriptor.registrationFile,
      f.descriptor.generation,
    ]),
    f.app.artifact.artifactDigest,
    () => {},
  );
  const proposal = {
    artifact: f.app.artifact,
    directories: new Set([f.root]),
    scope: { gate, participants: new Map() },
  };
  const job = {
    id: "upgrade-fixture",
    signal: controller.signal,
    assertCurrent: () => controller.signal.throwIfAborted(),
    connection: { client },
    phase: vi.fn(),
    installed: vi.fn(),
    scope: {
      digest: f.app.artifact.artifactDigest,
      root: f.root,
      transport: f.descriptor.registrationFile,
      descriptor: { ...f.descriptor, storageIdentity: f.owner.storageIdentity },
    },
  } as unknown as V2OwnedActivationJob;
  return {
    f,
    backend,
    saved,
    digest,
    secondDigest,
    second,
    retirement,
    identity,
    calls,
    active,
    client,
    controller,
    proposal,
    job,
    recovery: new V2ActivationRecovery(backend),
  };
}

it.each([false, true])(
  "recovers dead v3 owners before v4 publication (device renumbered: %s)",
  async (renumbered) => {
    const x = await fixture();
    let dispose: (() => Promise<void>) | undefined;
    try {
      if (renumbered) {
        const dev = Number(x.f.publication.rootIdentity.dev) + 1;
        await x.f.installations.replace(
          x.f.key,
          (await x.f.installations.read(x.f.key))!.revision,
          {
            ...x.f.publication,
            rootIdentity: { ...x.f.publication.rootIdentity, dev },
            pluginsIdentity: { ...x.f.publication.pluginsIdentity, dev },
            nextIdentity: { ...x.f.publication.nextIdentity, dev },
          },
        );
      }
      const original = await x.f.enrollments.inventory();
      const oldRpc = x.f.rpc.getMockImplementation()!;
      let published = false;
      let staleReads = 0;
      x.f.rpc.mockImplementation(async (input) => {
        if (
          !published &&
          input.method === "info" &&
          (await readFile(x.f.filename, "utf8")) !== x.f.entry.content
        ) {
          if (staleReads++ === 0) return oldRpc(input);
          const host = makeV2ThreadPluginHost(x.f.app.bind("new-native", x.f.root));
          host.context.app.version = "2.2.0";
          dispose = await (await import(x.f.app.artifact.entryUri)).default.setup(host.context);
          published = true;
          x.f.rpc.mockImplementation(async (request) => ({
            output: await host.call(request.method, request.input),
          }));
          return { output: await host.call(input.method, input.input) };
        }
        return oldRpc(input);
      });
      await x.f.run(() =>
        runV2ActivationTransaction(
          x.job,
          x.proposal,
          x.f.f.settings,
          x.f.coordinator.consent,
          (signal) => readV2ActivationIdle(x.job, x.proposal, signal),
          x.f.eligibility,
          x.recovery,
        ),
      );
      expect(x.job.installed).toHaveBeenCalledWith(
        x.f.app.artifact.artifactDigest,
        expect.anything(),
      );
      expect(x.calls.filter((call) => call === "detach")).toHaveLength(2);
      await x.retirement.assertSettled(x.identity(x.f.owner, x.digest));
      await x.retirement.assertSettled(x.identity(x.second, x.secondDigest));
      expect(await x.f.enrollments.inventory()).toEqual(original);
      expect(await readFile(x.f.filename, "utf8")).not.toBe(x.f.entry.content);
    } finally {
      await dispose?.();
      await x.f.close();
    }
  },
);

it.each(["native-active", "backend-live", "foreign-host", "cancelled", "other-storage"])(
  "preserves installation and owner evidence when upgrade recovery is %s",
  async (scenario) => {
    const x = await fixture();
    try {
      const before = await x.f.enrollments.inventory();
      if (scenario === "native-active")
        x.active.mockResolvedValue({
          [x.f.owner.nativeSessionId]: { type: "running" },
          [x.second.nativeSessionId]: { type: "running" },
        });
      if (scenario === "backend-live" || scenario === "foreign-host")
        vi.mocked(x.backend.classifyOwner).mockReturnValue(
          scenario === "backend-live" ? "live" : "foreign-host",
        );
      if (scenario === "cancelled") x.controller.abort();
      const job =
        scenario === "other-storage"
          ? {
              ...x.job,
              scope: {
                ...x.job.scope,
                descriptor: { ...x.job.scope.descriptor, storageIdentity: "different" },
              },
            }
          : x.job;
      await expect(
        x.f.run(() => x.recovery.retire(job, x.f.app.artifact, new Map(), x.controller.signal)),
      ).rejects.toThrow();
      expect(x.calls).not.toContain("detach");
      expect(await x.f.enrollments.inventory()).toEqual(before);
      expect(await readFile(x.f.filename, "utf8")).toBe(x.f.entry.content);
    } finally {
      await x.f.close();
    }
  },
);

it("does not require original native storage for already settled owners", async () => {
  const x = await fixture();
  try {
    await x.f.run(() => x.recovery.retire(x.job, x.f.app.artifact, new Map(), x.controller.signal));
    x.calls.length = 0;
    const job = {
      ...x.job,
      scope: {
        ...x.job.scope,
        descriptor: { ...x.job.scope.descriptor, storageIdentity: "different" },
      },
    };
    await x.f.run(() => x.recovery.retire(job, x.f.app.artifact, new Map(), x.controller.signal));
    expect(x.calls).toEqual([]);
  } finally {
    await x.f.close();
  }
});

it("preserves safe mismatch fields when the native watcher never loads the published bootstrap", async () => {
  const x = await fixture();
  try {
    await expect(
      x.f.run(() =>
        runV2ActivationTransaction(
          x.job,
          x.proposal,
          x.f.f.settings,
          x.f.coordinator.consent,
          (signal) => readV2ActivationIdle(x.job, x.proposal, signal),
          x.f.eligibility,
          x.recovery,
        ),
      ),
    ).rejects.toMatchObject({
      reasonCode: "bootstrap-contract-incompatible",
      fields: expect.arrayContaining(["bootstrapAbi"]),
    });
    expect(x.job.installed).not.toHaveBeenCalled();
  } finally {
    await x.f.close();
  }
});

it.each(["cancelled", "consent-revoked", "deadline"])(
  "joins issued preparation cleanup before releasing an upgrade that is %s",
  async (scenario) => {
    const x = await fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const issued = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalRpc = x.f.rpc.getMockImplementation()!;
    let detachCount = 0;
    x.f.rpc.mockImplementation(async (input) => {
      if (input.method === "detach") {
        detachCount++;
        entered();
        await blocked; // Deliberately ignore request abort, like delayed native I/O.
      }
      return originalRpc(input);
    });
    let settled = false;
    const running = x.f
      .run(() =>
        runV2ActivationTransaction(
          x.job,
          x.proposal,
          x.f.f.settings,
          x.f.coordinator.consent,
          (signal) => readV2ActivationIdle(x.job, x.proposal, signal),
          x.f.eligibility,
          x.recovery,
        ),
      )
      .then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      )
      .finally(() => {
        settled = true;
      });
    try {
      await issued;
      if (scenario === "cancelled") x.controller.abort();
      if (scenario === "consent-revoked") x.f.coordinator.consent.close();
      await delay(scenario === "deadline" ? 16000 : 100);
      expect(settled).toBe(false);
      expect(detachCount).toBe(1);
      expect(await readFile(x.f.filename, "utf8")).toBe(x.f.entry.content);
      release();
      expect((await running).ok).toBe(false);
      expect(detachCount).toBe(1);
      expect(x.job.installed).not.toHaveBeenCalled();
      expect(await readFile(x.f.filename, "utf8")).toBe(x.f.entry.content);
      expect(await x.f.enrollments.entries()).toHaveLength(2);
    } finally {
      release();
      await running;
      await x.f.close();
    }
  },
);
