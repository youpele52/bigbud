import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { ownV2WindowsFixture } from "./SharedService.windows.fixture.mjs";
import { exportV2ThreadArtifact } from "./Orchestration.artifact.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { publishV2ManagedPlugin } from "./PluginSetup.publication.ts";
import { v2ManagedPluginFilename } from "./PluginSetup.record.ts";
import { windowsMkdir, windowsRead, windowsList, v2WindowsFiles } from "./NativeFiles.windows.ts";

it.skipIf(process.platform !== "win32")(
  "real Windows issuer, immutable artifacts, signed record locks and managed publication survive reopen",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "windows-setup-"));
    try {
      await ownV2WindowsFixture(root);
      const artifact = await exportV2ThreadArtifact(root);
      expect((await exportV2ThreadArtifact(root)).artifactDigest).toBe(artifact.artifactDigest);
      await artifact.verify();
      const records = await V2ThreadRecords.open(
        artifact.root,
        "receipts",
        artifact.privateKey,
        artifact.publicKey,
      );
      const revision = await records.replace("fixture", undefined, {
        state: "reserved",
        outcome: "unknown",
      });
      await expect(records.replace("fixture", "0".repeat(32), {})).rejects.toThrow("successor");
      expect((await records.read("fixture"))?.value).toEqual({
        state: "reserved",
        outcome: "unknown",
      });
      await records.replace("fixture", revision, { fixtureOnly: true });
      expect((await records.inventory()).length).toBe(1);
      const config = path.join(root, "config");
      await windowsMkdir(root, "config", () => {});
      const authority = { signal: new AbortController().signal, assertCurrent: () => {} };
      await publishV2ManagedPlugin(artifact, config, authority);
      const entry = await windowsRead(
        path.join(config, "plugins", v2ManagedPluginFilename(artifact)),
        true,
      );
      expect(entry.content).toContain(artifact.entryUri);
      await publishV2ManagedPlugin(artifact, config, authority);
      expect(await windowsList(path.join(config, "plugins"))).toEqual([
        v2ManagedPluginFilename(artifact),
      ]);
      const installed = await V2ThreadRecords.open(
        artifact.root,
        "installations",
        artifact.privateKey,
        artifact.publicKey,
      );
      expect(
        (await installed.read(JSON.stringify([config, v2ManagedPluginFilename(artifact)])))?.value,
      ).toMatchObject({ phase: "committed", nextIdentity: entry.identity });
    } finally {
      v2WindowsFiles.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
