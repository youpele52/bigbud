import { vi } from "vitest";
import * as Host from "./RebootRecovery.host.ts";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import {
  v2LegacyThreadOwnerDigest,
  type V2LegacyThreadOwner,
} from "./Orchestration.protocol.legacy.ts";
import type { V2RecoveryJournal } from "./RebootRecovery.evidence.ts";

const ownerKey = (owner: V2LegacyThreadOwner) =>
  JSON.stringify([owner.storageIdentity, owner.nativeSessionId, owner.threadId]);

async function makeFixture() {
  const app = await makeV2ThreadPluginFixture({ legacyRegistration: true });
  let host = {
    host: "a".repeat(64),
    bootSession: "11111111-1111-1111-1111-111111111111",
    bootSeconds: 100,
    bootMicroseconds: 1,
  };
  const spy = vi.spyOn(Host, "readV2RecoveryHost").mockImplementation(async () => host);
  const open = (name: "enrollments" | "receipts") =>
    V2ThreadRecords.open(app.artifact.root, name, app.artifact.privateKey, app.artifact.publicKey);
  const enrollments = await open("enrollments"),
    receipts = await open("receipts");
  const legacy: V2LegacyThreadOwner = {
    protocol: "bigbud.thread.v1",
    issuer: app.artifact.issuer,
    artifactDigest: app.artifact.artifactDigest,
    threadId: "original",
    nativeSessionId: "native-original",
    storageIdentity: "storage",
    directory: "/owned-location",
    runtimeTargetId: "local",
    workspaceTargetId: "local",
    sessionEpoch: 1,
    transportGeneration: "original-native-generation",
    consentRevision: 1,
    enrollmentNonce: "a".repeat(32),
    callbackUrl: "http://127.0.0.1:5000/callback",
    callbackToken: "b".repeat(64),
  };
  const addOwner = async (owner: V2LegacyThreadOwner) =>
    enrollments.replace(ownerKey(owner), undefined, {
      owner,
      digest: v2LegacyThreadOwnerDigest(owner),
      state: "active",
      acknowledged: { revision: 1, expiry: 1 },
      pending: null,
    });
  await addOwner(legacy);
  await receipts.replace("call", undefined, { fingerprint: "fingerprint", state: "reserved" });
  const originalReceipt = await receipts.read("call");
  const journal: V2RecoveryJournal = {
    admissions: [
      {
        namespace: "foreground",
        owner_thread_id: legacy.threadId,
        request_message_id: "message",
        binding_json: JSON.stringify({
          provider: "opencodeV2",
          threadId: legacy.threadId,
          nativeSessionId: legacy.nativeSessionId,
          storageIdentity: legacy.storageIdentity,
          location: legacy.directory,
          runtimeTargetId: "local",
          workspaceTargetId: "local",
        }),
        fingerprint: "fingerprint",
        native_admission_id: "native-admission",
        turn_id: "turn",
        state: "terminal",
        revision: 3,
        terminal_outcome: "completed",
      },
    ],
    bindings: [
      {
        state: "verified",
        revision: 2,
        material_json: JSON.stringify({
          threadId: legacy.threadId,
          nativeSessionId: legacy.nativeSessionId,
          storageIdentity: legacy.storageIdentity,
          directory: legacy.directory,
          runtimeTargetId: "local",
          workspaceTargetId: "local",
        }),
      },
    ],
  };
  const readJournal = async () => journal;
  let busy = false,
    fail = false,
    idleCalls = 0;
  return {
    artifact: app.artifact,
    enrollments,
    receipts,
    legacy,
    originalReceipt,
    addOwner,
    prepare: {
      enrollments,
      issuer: app.artifact.issuer,
      threadIds: [legacy.threadId],
      receiptNames: (await receipts.inventory()).map((entry) => entry.name),
      backup: { directory: app.root, databaseDigest: "d".repeat(64) },
      readJournal,
    },
    apply: {
      enrollments,
      readJournal,
      assertCurrent: () => {},
      assertIdle: async () => {
        if (busy) throw new Error("native activity");
        if (fail && ++idleCalls === 2) throw new Error("simulated crash");
      },
    },
    reboot: () => {
      host = { ...host, bootSeconds: 200, bootSession: "22222222-2222-2222-2222-222222222222" };
    },
    failBeforeSeal: () => {
      fail = true;
      idleCalls = 0;
    },
    resume: () => {
      fail = false;
    },
    change: async (kind: "owner" | "receipt" | "journal" | "host" | "activity") => {
      if (kind === "owner") {
        const prior = (await enrollments.read(ownerKey(legacy)))!;
        await enrollments.replace(ownerKey(legacy), prior.revision, {
          ...(prior.value as object),
          pending: { revision: 2, expiry: Date.now() + 50000 },
        });
      }
      if (kind === "receipt")
        await receipts.replace("call", originalReceipt!.revision, {
          fingerprint: "changed",
          state: "reserved",
        });
      if (kind === "journal") journal.admissions[0]!.state = "accepted";
      if (kind === "host") host = { ...host, host: "f".repeat(64) };
      if (kind === "activity") busy = true;
    },
    close: async () => {
      spy.mockRestore();
      await app.close();
    },
  };
}

/** Real signed records and production retirement/receipt readers; only OS/journal/activity observations are synthetic. */
export async function withRebootRecoveryFixture(
  run: (f: Awaited<ReturnType<typeof makeFixture>>) => Promise<void>,
) {
  const fixture = await makeFixture();
  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
}
