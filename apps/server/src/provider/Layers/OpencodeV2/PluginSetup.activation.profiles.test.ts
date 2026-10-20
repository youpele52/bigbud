import path from "node:path";
import { mkdir, writeFile, readFile, lstat } from "node:fs/promises";
import { expect, it } from "vitest";
import { makeV2ActivationTransactionFixture } from "./PluginSetup.activation.transaction.fixture.ts";
import { makeV2ThreadPluginHost } from "./Orchestration.plugin.host.fixture.ts";
import { makeV2LegacyRegistrationFixture } from "./Orchestration.registration.legacy.fixture.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { digestV2EnrollmentOwner } from "./Orchestration.enrollment.record.ts";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";
import { v2ManagedPluginFilename, v2ManagedPluginEntry } from "./PluginSetup.record.ts";
import { selectV2SessionArtifact } from "./Orchestration.selection.ts";

// Real automatic installer, activity guard, activation transaction, signed publication and
// generated plugin readiness. Only native SDK reads/watching and native qualification are synthetic.
it.each(["legacy", "legacy-foreground", "legacy-shell", "scoped", "invalid-legacy"] as const)(
  "automatic scoped activation respects the registration boundary with an unsettled %s owner",
  async (family) => {
    const f = await makeV2ActivationTransactionFixture();
    let dispose: (() => Promise<void>) | undefined;
    try {
      f.participants.clear();
      const artifact = f.app.artifact,
        selected = v2ThreadRegistration(artifact);
      const old = await makeV2LegacyRegistrationFixture(artifact);
      await mkdir(path.join(f.root, "plugins"), { mode: 0o700 });
      const legacyFile = path.join(f.root, "plugins", v2ManagedPluginFilename(old));
      const legacyContent = v2ManagedPluginEntry(old, f.root).content;
      await writeFile(legacyFile, legacyContent, { mode: 0o600 });
      const legacyIdentity = await lstat(legacyFile);
      const owner = {
        ...f.app.bind("retained-native-history", f.root),
        ...(family === "scoped"
          ? {}
          : {
              bootstrapDigest: old.bootstrapDigest,
              bootstrapAbi: old.bootstrapAbi,
              compatibilityDigest: old.compatibilityDigest,
            }),
      };
      const records = await V2ThreadRecords.open(
        artifact.root,
        "enrollments",
        artifact.privateKey,
        artifact.publicKey,
      );
      await records.replace("unsettled-owner", undefined, {
        owner,
        digest: family === "invalid-legacy" ? "0".repeat(64) : digestV2EnrollmentOwner(owner),
        state: "pending",
        acknowledged: null,
        pending: { revision: 1, expiry: Date.now() - 1000 },
      });
      const before = await records.inventory();
      const filename = path.join(f.root, "plugins", v2ManagedPluginFilename(artifact));
      const host = makeV2ThreadPluginHost(f.app.bind("new-scoped-history", f.root));
      let activeReads = 0;
      let nativeBusy = family === "legacy-foreground" || family === "legacy-shell";
      Object.assign(f.client, {
        session: {
          active: async () => {
            activeReads++;
            return nativeBusy && family === "legacy-foreground"
              ? { retained: { type: "running" } }
              : {};
          },
        },
        debug: { location: { list: async () => [{ directory: f.root }] } },
        shell: {
          list: async ({ location }: { location: { directory: string } }) => ({
            location,
            data: nativeBusy && family === "legacy-shell" ? [{ status: "running" }] : [],
          }),
        },
        plugin: {
          list: async () => {
            const published = await readFile(filename, "utf8").catch((error) => {
              if (error.code === "ENOENT") return undefined;
              throw error;
            });
            if (published && !dispose) {
              expect(published).toContain(artifact.entryUri);
              dispose = await (
                await import(/* @vite-ignore */ artifact.entryUri)
              ).default.setup(host.context);
            }
            return {
              location: { directory: f.root },
              data: [
                {
                  id: "bigbud.thread.v1",
                  source: { type: "local", path: legacyFile },
                  state: { status: "active" },
                },
                ...(dispose
                  ? [
                      {
                        id: selected.id,
                        source: { type: "local", path: filename },
                        state: { status: "active" },
                      },
                    ]
                  : []),
              ],
            };
          },
        },
        rpc: {
          call: async (input: { rpcID: string; method: string; input: unknown }) => {
            expect(input.rpcID).toBe(selected.id);
            return { output: await host.call(input.method, input.input) };
          },
        },
      });
      const handle = f.jobs.request({ ...f.scope, registrationId: selected.id });
      if (nativeBusy) {
        await f.waiting.promise;
        expect(f.jobs.status(handle.jobId, { ...f.scope, registrationId: selected.id }).state).toBe(
          "waiting-for-idle",
        );
        expect(await lstat(filename).catch(() => undefined)).toBeUndefined();
        expect(await records.inventory()).toEqual(before);
        nativeBusy = false;
      }
      const result = await f.jobs.wait(handle, { ...f.scope, registrationId: selected.id });
      if (family.startsWith("legacy")) {
        expect(result.state, JSON.stringify(result)).toBe("ready");
        expect(await readFile(filename, "utf8")).toContain(artifact.entryUri);
        expect(activeReads).toBeGreaterThan(0);
        expect((await host.call("info")).issuer).toBe(artifact.issuer);
        const retained = await selectV2SessionArtifact(artifact, records, {
          threadId: owner.threadId,
          nativeSessionId: owner.nativeSessionId,
          storageIdentity: owner.storageIdentity,
          directory: owner.directory,
          registrationFamily: "legacy",
        });
        expect(retained.artifactDigest).toBe(old.artifactDigest);
      } else {
        expect(result).toMatchObject({ state: "failed" });
        expect(JSON.stringify(result)).toContain(
          family === "scoped" ? "retained owner retirement" : "invalid signed enrollment",
        );
        expect(await lstat(filename).catch(() => undefined)).toBeUndefined();
      }
      expect(await records.inventory()).toEqual(before);
      expect(f.retire).not.toHaveBeenCalled();
      expect(await readFile(legacyFile, "utf8")).toBe(legacyContent);
      expect((await lstat(legacyFile)).ino).toBe(legacyIdentity.ino);
    } finally {
      await dispose?.();
      await f.cleanup();
    }
  },
);
