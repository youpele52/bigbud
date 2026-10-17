import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as Host from "./RebootRecovery.host.ts";
import { withRebootRecoveryFixture } from "./RebootRecovery.fixture.ts";
import { prepareV2RebootRecovery, applyV2RebootRecovery } from "./RebootRecovery.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { readV2NativePluginFile, v2NativePluginDirectory } from "./PluginSetup.fs.ts";
import { V2_MANAGED_PLUGIN_FILENAME, v2ManagedPluginEntry } from "./PluginSetup.record.ts";
import {
  prepareV2InstallationRevalidation,
  recoverV2InstallationRevalidation,
} from "./PluginSetup.revalidation.ts";
import { publishV2ManagedPlugin } from "./PluginSetup.publication.ts";
import { makeV2IdentityPublication } from "./PluginSetup.activation.identity.ts";
import { V2ActivationGate } from "./PluginSetup.activation.gate.ts";
import { readV2ActivationIdle } from "./PluginSetup.activation.activity.ts";
import type { V2OwnedActivationJob } from "./PluginSetup.activation.jobs.ts";

const authority = () => ({
  signal: new AbortController().signal,
  assertCurrent: () => {},
  publication: {
    prepare: async () => {},
    locked: async () => () => {},
    assertGate: () => {},
    beforeMutation: async () => {},
    joinPhysicalOnCancel: true as const,
  },
});

it
  .skipIf(process.platform === "win32")
  .each([
    "valid",
    "missing-consent",
    "inode",
    "content",
    "issuer",
    "mixed-device",
    "backup",
    "revoked",
    "busy",
    "successor",
    "crash",
    "later-boot",
    "host",
    "plugins-inode",
    "plugin-inode",
    "permissions",
    "changed-after-consent",
    "signer",
    "cancelled",
    "metadata-retained-owners",
    "metadata-changed-artifact",
    "metadata-qualification",
    "metadata-local-busy",
    "metadata-revoked",
    "metadata-revoked-during",
    "metadata-participant-busy",
    "metadata-successor",
  ])("explicit same-artifact later-boot installation revalidation: %s", async (scenario) => {
  await withRebootRecoveryFixture(async (f) => {
    await prepareV2RebootRecovery(f.prepare);
    f.reboot();
    await applyV2RebootRecovery(f.apply);
    const ownersBefore = await f.enrollments.inventory();
    const recoveryStore = await f.enrollments.sibling("recovery");
    const recoveryBefore = await recoveryStore.inventory();
    const sealed = await Host.readV2RecoveryHost();
    vi.spyOn(Host, "readV2RecoveryHost").mockResolvedValue({
      ...sealed,
      bootSeconds: 300,
      bootSession: "33333333-3333-3333-3333-333333333333",
    });
    const root = path.join(f.prepare.backup.directory, "native-config");
    await mkdir(path.join(root, "plugins"), { recursive: true, mode: 0o700 });
    const entry = v2ManagedPluginEntry(f.artifact, root);
    const filename = path.join(root, "plugins", V2_MANAGED_PLUGIN_FILENAME);
    await writeFile(filename, entry.content, { mode: 0o600 });
    const rootIdentity = await v2NativePluginDirectory(root);
    const pluginsIdentity = await v2NativePluginDirectory(path.join(root, "plugins"));
    const native = (await readV2NativePluginFile(filename, true))!;
    if (typeof rootIdentity.dev !== "number" || typeof rootIdentity.ino !== "number")
      throw new Error("POSIX fixture");
    const oldDev = rootIdentity.dev + 1;
    const record = {
      protocol: "bigbud.thread.install.v1",
      root,
      phase: "committed",
      rootIdentity: { ...rootIdentity, dev: oldDev },
      pluginsIdentity: { ...pluginsIdentity, dev: oldDev },
      next: entry,
      nextIdentity: { ...native.identity, dev: oldDev },
      previous: null,
      previousIdentity: null,
    };
    if (scenario === "inode") record.rootIdentity.ino = Number(record.rootIdentity.ino) + 1;
    if (scenario === "plugins-inode")
      record.pluginsIdentity.ino = Number(record.pluginsIdentity.ino) + 1;
    if (scenario === "plugin-inode") record.nextIdentity.ino = Number(record.nextIdentity.ino) + 1;
    if (scenario === "mixed-device") record.pluginsIdentity.dev++;
    if (scenario === "issuer") record.next = { ...entry, issuer: "e".repeat(64) };
    const records = await V2ThreadRecords.open(
      f.artifact.root,
      "installations",
      f.artifact.privateKey,
      f.artifact.publicKey,
    );
    const key = JSON.stringify([root, V2_MANAGED_PLUGIN_FILENAME]);
    await records.replace(key, undefined, record);
    const signed = (await records.read(key))!;
    const backup = f.prepare.backup;
    await mkdir(path.join(backup.directory, "installations"), { mode: 0o700 });
    const savedFile = path.join(
      backup.directory,
      "installations",
      createHash("sha256").update(key).digest("hex"),
    );
    await writeFile(savedFile, JSON.stringify(signed), { mode: 0o600 });
    await writeFile(path.join(backup.directory, V2_MANAGED_PLUGIN_FILENAME), entry.content, {
      mode: 0o600,
    });
    if (scenario === "backup") await writeFile(savedFile, "{}", { mode: 0o600 });
    if (scenario === "content") await writeFile(filename, "foreign", { mode: 0o600 });
    if (scenario === "permissions") await chmod(filename, 0o644);
    const prepare = () =>
      prepareV2InstallationRevalidation(records, root, f.artifact.issuer, backup, () => {});
    if (
      [
        "inode",
        "plugins-inode",
        "plugin-inode",
        "permissions",
        "mixed-device",
        "issuer",
        "backup",
        "content",
      ].includes(scenario)
    ) {
      await expect(prepare()).rejects.toThrow();
      expect(await records.read(key)).toEqual(signed);
      return;
    }
    if (scenario !== "missing-consent") {
      await prepare();
      await prepare(); // Crash/retry preparation is idempotent.
    }
    if (scenario === "host")
      vi.spyOn(Host, "readV2RecoveryHost").mockResolvedValue({
        ...sealed,
        host: "f".repeat(64),
        bootSeconds: 300,
        bootSession: "33333333-3333-3333-3333-333333333333",
      });
    if (scenario === "later-boot")
      vi.spyOn(Host, "readV2RecoveryHost").mockResolvedValue({
        ...sealed,
        bootSeconds: 400,
        bootSession: "44444444-4444-4444-4444-444444444444",
      });
    const recover = () => recoverV2InstallationRevalidation(records, key, signed, f.artifact, root);
    if (["missing-consent", "later-boot", "host"].includes(scenario)) {
      await expect(recover()).rejects.toThrow();
      expect(await records.read(key)).toEqual(signed);
      return;
    }
    const candidate = await recover();
    expect(await records.read(key)).toEqual(signed);
    const owned = authority();
    if (scenario.startsWith("metadata-")) {
      for (let i = 0; i < 5; i++)
        await f.addOwner({
          ...f.legacy,
          threadId: `retained-${i}`,
          enrollmentNonce: String(i + 1).repeat(32),
        });
      const before = await f.enrollments.inventory();
      const gate = new V2ActivationGate("metadata-scope", f.artifact.artifactDigest, () => {});
      const active = vi.fn(async () => ({ unrelated: { type: "running" } }));
      const job = {
        id: "metadata-job",
        signal: owned.signal,
        assertCurrent: () => owned.assertCurrent(),
        phase: vi.fn(),
        connection: { client: { session: { active } } },
      } as unknown as V2OwnedActivationJob;
      const proposal = {
        artifact: f.artifact,
        directories: new Set([root]),
        scope: { gate, participants: new Map() },
      };
      const normalPrepare = vi.fn(async () => {
        await readV2ActivationIdle(job, proposal);
      });
      const eligibility = vi.fn(async () => {
        if (scenario === "metadata-qualification") throw new Error("qualification changed");
        if (scenario === "metadata-revoked-during" && eligibility.mock.calls.length === 2)
          owned.assertCurrent = () => {
            throw new Error("revoked during maintenance");
          };
      });
      if (scenario === "metadata-participant-busy")
        proposal.scope.participants.set("local", { busyCount: () => 1 });
      const metadata = makeV2IdentityPublication(
        job,
        gate,
        proposal.scope.participants,
        eligibility,
      );
      const granted = {
        ...owned,
        publication: {
          ...owned.publication,
          prepare: normalPrepare,
          identityRevalidation: metadata.authority,
        },
      };
      const proposed =
        scenario === "metadata-changed-artifact"
          ? { ...f.artifact, artifactDigest: "e".repeat(64) }
          : f.artifact;
      if (scenario === "metadata-local-busy")
        gate.tryReserve(gate.verify(root, f.artifact.artifactDigest, "native-setup"), "busy");
      if (scenario === "metadata-revoked")
        owned.assertCurrent = () => {
          throw new Error("revoked");
        };
      if (scenario === "metadata-successor") await records.replace(key, signed.revision, record);
      try {
        if (scenario === "metadata-retained-owners") {
          await publishV2ManagedPlugin(proposed, root, granted);
          expect((await records.read(key))?.value).toMatchObject({
            rootIdentity,
            phase: "committed",
            next: entry,
          });
          expect(gate.snapshot().epoch).toBe(0); // Metadata cannot invalidate an existing code epoch.
          expect(normalPrepare).not.toHaveBeenCalled();
          expect(eligibility).toHaveBeenCalledTimes(2);
          await publishV2ManagedPlugin(proposed, root, granted); // Identity maintenance is idempotent with retained owners.
          await expect(readV2ActivationIdle(job, proposal)).rejects.toThrow(
            "retained owner retirement",
          );
        } else {
          await expect(publishV2ManagedPlugin(proposed, root, granted)).rejects.toThrow(
            scenario === "metadata-changed-artifact" ? "retained owner retirement" : undefined,
          );
          if (scenario !== "metadata-successor") expect(await records.read(key)).toEqual(signed);
        }
      } finally {
        await metadata.close();
      }
      expect(active).not.toHaveBeenCalled();
      expect(await f.enrollments.inventory()).toEqual(before);
      expect(await f.receipts.read("call")).toEqual(f.originalReceipt);
      expect(await readFile(filename, "utf8")).toBe(entry.content);
      expect((await readV2NativePluginFile(filename, true))?.identity).toEqual(native.identity);
      const retainedRecovery = await recoveryStore.inventory();
      for (const original of recoveryBefore)
        expect(retainedRecovery.find((entry) => entry.name === original.name)).toEqual(original);
      return;
    }
    if (scenario === "cancelled") owned.signal = AbortSignal.abort();
    if (scenario === "changed-after-consent") await writeFile(filename, "foreign", { mode: 0o600 });
    if (scenario === "signer") {
      const signedFile = path.join(records.directory, path.basename(savedFile));
      await writeFile(signedFile, JSON.stringify({ ...signed, signature: "A".repeat(86) }), {
        mode: 0o600,
      });
      await expect(publishV2ManagedPlugin(f.artifact, root, owned)).rejects.toThrow(
        "signed record rejected",
      );
      return;
    }
    if (scenario === "revoked")
      owned.assertCurrent = () => {
        throw new Error("revoked");
      };
    if (scenario === "busy")
      await f.addOwner({ ...f.legacy, threadId: "new", enrollmentNonce: "c".repeat(32) });
    if (scenario === "successor") await records.replace(key, signed.revision, record);
    if (scenario === "crash") {
      owned.publication.beforeMutation = async () => {
        throw new Error("crash before replacement");
      };
      await expect(candidate.archive(owned)).rejects.toThrow("crash");
      expect(await records.read(key)).toEqual(signed);
      await candidate.archive(authority());
    } else if (
      ["revoked", "busy", "successor", "cancelled", "changed-after-consent"].includes(scenario)
    ) {
      await expect(candidate.archive(owned)).rejects.toThrow();
      if (scenario !== "successor") expect(await records.read(key)).toEqual(signed);
      return;
    } else {
      // Exercise the actual same-hash fast path: the signed identity must still be persisted.
      await publishV2ManagedPlugin(f.artifact, root, owned);
      await publishV2ManagedPlugin(f.artifact, root, owned);
    }
    expect((await records.read(key))?.value).toMatchObject({
      rootIdentity,
      phase: "committed",
      next: entry,
    });
    expect(await readFile(filename, "utf8")).toBe(entry.content);
    expect(await f.receipts.read("call")).toEqual(f.originalReceipt);
    expect(await f.enrollments.inventory()).toEqual(ownersBefore);
    const recoveryAfter = await recoveryStore.inventory();
    for (const original of recoveryBefore)
      expect(recoveryAfter.find((entry) => entry.name === original.name)).toEqual(original);
  });
});
