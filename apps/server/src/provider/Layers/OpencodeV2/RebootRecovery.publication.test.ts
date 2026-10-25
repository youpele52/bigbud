import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { withRebootRecoveryFixture } from "./RebootRecovery.fixture.ts";
import { prepareV2RebootRecovery, applyV2RebootRecovery } from "./RebootRecovery.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { v2NativePluginDirectory, readV2NativePluginFile } from "./PluginSetup.fs.ts";
import { v2ManagedPluginEntry, V2_MANAGED_PLUGIN_FILENAME } from "./PluginSetup.record.ts";
import { recoverV2RebootPublication } from "./RebootRecovery.publication.ts";
import { publishV2ManagedPlugin } from "./PluginSetup.publication.ts";
import { withV2RuntimeWarningFixture } from "./NativeCompatibility.runtime.warning.fixture.ts";
import { verifyV2NativeEligibility } from "./NativeCompatibility.runtime.ts";
import type { V2NativeRuntimeProof } from "./NativeCompatibility.types.ts";
import { V2ActivationGate } from "./PluginSetup.activation.gate.ts";

it
  .skipIf(process.platform === "win32")
  .each(["valid", "no-seal", "inode", "content", "backup", "mixed-device"])(
  "revalidates only exact reboot-backed managed entry evidence: %s",
  async (scenario) => {
    await withRebootRecoveryFixture(async (f) => {
      const root = path.join(f.prepare.backup.directory, "native-config");
      await mkdir(root, { mode: 0o700 });
      await mkdir(path.join(root, "plugins"), { mode: 0o700 });
      const entry = v2ManagedPluginEntry(f.artifact, root);
      const filename = path.join(root, "plugins", V2_MANAGED_PLUGIN_FILENAME);
      await writeFile(filename, entry.content, { mode: 0o600 });
      const rootIdentity = await v2NativePluginDirectory(root);
      const pluginsIdentity = await v2NativePluginDirectory(path.join(root, "plugins"));
      const current = (await readV2NativePluginFile(filename, true))!;
      if (typeof rootIdentity.dev !== "number" || typeof rootIdentity.ino !== "number")
        throw new Error("POSIX identity required");
      const oldDev = rootIdentity.dev + 1;
      const record = {
        protocol: "bigbud.thread.install.v1",
        root,
        phase: "committed",
        rootIdentity: { ino: rootIdentity.ino, dev: oldDev },
        pluginsIdentity: { ...pluginsIdentity, dev: oldDev },
        previous: null,
        previousIdentity: null,
        next: entry,
        nextIdentity: { ...current.identity, dev: oldDev },
      };
      if (scenario === "inode") record.rootIdentity.ino++;
      if (scenario === "mixed-device") record.pluginsIdentity.dev++;
      const records = await V2ThreadRecords.open(
        f.artifact.root,
        "installations",
        f.artifact.privateKey,
        f.artifact.publicKey,
      );
      const key = JSON.stringify([root, V2_MANAGED_PLUGIN_FILENAME]);
      await records.replace(key, undefined, record);
      const signed = (await records.read(key))!;
      const name = createHash("sha256").update(key).digest("hex");
      const backup = path.join(f.prepare.backup.directory, "installations");
      await mkdir(backup, { mode: 0o700 });
      await writeFile(path.join(backup, name), JSON.stringify(signed), { mode: 0o600 });
      await prepareV2RebootRecovery(f.prepare);
      f.reboot();
      if (scenario !== "no-seal") await applyV2RebootRecovery(f.apply);
      if (scenario === "content") await writeFile(filename, "foreign", { mode: 0o600 });
      if (scenario === "backup") await writeFile(path.join(backup, name), "{}", { mode: 0o600 });
      const recover = () =>
        recoverV2RebootPublication(records, key, signed, f.artifact, root, rootIdentity);
      if (scenario !== "valid") {
        await expect(recover()).rejects.toThrow();
        return;
      }
      const candidate = await recover();
      expect(candidate.record.rootIdentity).toEqual(rootIdentity);
      expect(await records.read(key)).toEqual(signed); // Candidate is not a rewritten installation.
      const authority = {
        signal: new AbortController().signal,
        assertCurrent: () => {},
        publication: {
          assertGate: () => {},
          prepare: async () => {},
          locked: async () => () => {},
          beforeMutation: async () => {},
          joinPhysicalOnCancel: true as const,
        },
      };
      await candidate.archive(authority);
      await candidate.archive(authority); // crash retry retains one exact archive
      expect(await readFile(filename, "utf8")).toBe(entry.content);
      await expect(
        candidate.archive({
          ...authority,
          assertCurrent: () => {
            throw new Error("revoked");
          },
        }),
      ).rejects.toThrow("revoked");
      // Synthetic successor exercises the real publication/archive ordering, not native qualification.
      const successor = { ...f.artifact, artifactDigest: "f".repeat(64) };
      await withV2RuntimeWarningFixture("2.0.29", async (runtime) => {
        runtime.config.mockResolvedValue([{ type: "directory", path: root }]);
        let proof: V2NativeRuntimeProof | undefined;
        const gate = new V2ActivationGate("fixture", successor.artifactDigest, () => {});
        await publishV2ManagedPlugin(successor, root, {
          ...authority,
          publication: {
            ...authority.publication,
            assertGate: () => {
              proof?.assertCurrent();
              if (proof) gate.assertGate("fixture-job");
            },
            locked: async () => {
              expect(gate.tryCloseGate("fixture-job")).toBe(true);
              proof = await verifyV2NativeEligibility(successor, runtime.client, root, root);
              return () => gate.releaseGate("fixture-job");
            },
            beforeMutation: async () => gate.assertGate("fixture-job"),
          },
        });
      });
      expect(await readFile(filename, "utf8")).toBe(v2ManagedPluginEntry(successor, root).content);
      expect((await records.read(key))?.value).toMatchObject({
        phase: "committed",
        rootIdentity,
        next: { artifactDigest: successor.artifactDigest },
      });
      expect(await f.receipts.read("call")).toEqual(f.originalReceipt);
      await writeFile(filename, "replaced-after-observation", { mode: 0o600 });
      await expect(candidate.archive(authority)).rejects.toThrow();
    });
  },
);
