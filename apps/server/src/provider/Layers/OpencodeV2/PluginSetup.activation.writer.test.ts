import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { makeV2ActivationTransactionFixture } from "./PluginSetup.activation.transaction.fixture.ts";
import { deferred } from "./Test.fixtures.ts";
import { publishV2ManagedPlugin } from "./PluginSetup.publication.ts";
import { currentV2RequestContext } from "./Client.guard.ts";
import { exportV2ThreadArtifact } from "./Orchestration.artifact.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { v2ManagedPluginFilename } from "./PluginSetup.record.ts";
import type { makeV2AutomaticPluginSetup } from "./PluginSetup.native.ts";

const hook = vi.hoisted(() => ({
  revision: false,
  wait: undefined as undefined | (() => Promise<void>),
}));
vi.mock("./Orchestration.plugin.ts", async (original) => {
  const source = await original<typeof import("./Orchestration.plugin.ts")>();
  return {
    ...source,
    renderV2ThreadPlugin: () =>
      source.renderV2ThreadPlugin() +
      (hook.revision ? "\n// Owned writer deadline revision\n" : ""),
  };
});
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    link: async (...args: Parameters<typeof fs.link>) => {
      if (/bigbud-thread-tools-[a-f0-9]{64}\.js$/.test(String(args[1]))) await hook.wait?.();
      return fs.link(...args);
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (/bigbud-thread-tools-[a-f0-9]{64}\.js$/.test(String(args[1]))) await hook.wait?.();
      return fs.rename(...args);
    },
  };
});
vi.mock("./PluginSetup.native.ts", () => ({
  makeV2AutomaticPluginSetup: ((settings, _consent, publication) =>
    async (artifact, _client, _directory, signal) => {
      await publishV2ManagedPlugin(
        artifact,
        settings.currentSnapshot!()!.settings.providers.opencodeV2.nativePluginConfigRoot!,
        {
          signal: signal!,
          assertCurrent: () => currentV2RequestContext()?.permit.assertCurrent(),
          ...(publication ? { publication } : {}),
        },
      );
      return artifact;
    }) satisfies typeof makeV2AutomaticPluginSetup,
}));
vi.mock("./Orchestration.readiness.ts", () => ({
  verifyV2ThreadTools: async (artifact: { artifactDigest: string }) => ({
    bootstrapDigest: artifact.artifactDigest,
    setupInstanceId: "a".repeat(32),
  }),
}));

it.each(["link", "rename"] as const)(
  "issued %s retains physical writer ownership after the 15-second gate and cannot turn into an automatic busy retry",
  async (kind) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const held = deferred<void>(),
      entered = deferred<void>(),
      f = await makeV2ActivationTransactionFixture(async () => true);
    const filename = path.join(f.root, "plugins", v2ManagedPluginFilename(f.app.artifact));
    try {
      if (kind === "rename") {
        await publishV2ManagedPlugin(f.app.artifact, f.root, {
          signal: new AbortController().signal,
          assertCurrent: () => {},
        });
        hook.revision = true;
        f.app.artifact = await exportV2ThreadArtifact(f.app.root);
        f.scope.digest = f.app.artifact.artifactDigest;
      }
      hook.wait = async () => {
        entered.resolve();
        await held.promise;
      };
      const handle = f.jobs.request(f.scope);
      await entered.promise;
      await vi.advanceTimersByTimeAsync(30000);
      expect(f.jobs.status(handle.jobId, f.scope).state).toBe("uncertain");
      expect(f.jobs.isSettled(handle.jobId)).toBe(false);
      expect(f.close).not.toHaveBeenCalled();
      expect(() => f.gate.assertOpen()).not.toThrow();
      expect(f.gate.knownReady(f.root)).toBeUndefined();
      const lock = path.join(
        f.root,
        "plugins",
        `.bigbud-thread-tools-${f.app.artifact.issuer}.lock`,
      );
      const locked = await lstat(lock);
      await expect(
        publishV2ManagedPlugin(f.app.artifact, f.root, {
          signal: new AbortController().signal,
          scopeKey: "successor",
          assertCurrent: () => {},
        }),
      ).rejects.toThrow("conflicts");
      expect((await lstat(lock)).ino).toBe(locked.ino);
      const records = await V2ThreadRecords.open(
        f.app.artifact.root,
        "installations",
        f.app.artifact.privateKey,
        f.app.artifact.publicKey,
      );
      const record = await records.read(
        JSON.stringify([f.root, v2ManagedPluginFilename(f.app.artifact)]),
      );
      expect(record?.value).toMatchObject({ phase: "publishing" });
      held.resolve();
      await expect(f.jobs.wait(handle, f.scope)).resolves.toMatchObject({ state: "uncertain" });
      expect(f.close).toHaveBeenCalledTimes(1);
      expect(await readFile(filename, "utf8")).toContain(f.app.artifact.entryUri);
      expect(
        (await records.read(JSON.stringify([f.root, v2ManagedPluginFilename(f.app.artifact)])))
          ?.value,
      ).toMatchObject({ phase: "publishing" });
    } finally {
      hook.wait = undefined;
      hook.revision = false;
      held.resolve();
      await f.cleanup();
      vi.useRealTimers();
    }
  },
);
