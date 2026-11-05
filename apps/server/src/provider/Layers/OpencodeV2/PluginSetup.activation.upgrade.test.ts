import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import * as Identity from "./Orchestration.plugin.identity.ts";
import { exportV2ThreadArtifact } from "./Orchestration.artifact.ts";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { makeV2ThreadPluginHost } from "./Orchestration.plugin.host.fixture.ts";
import { makeV2ActivationJobsFixture } from "./PluginSetup.activation.jobs.fixture.ts";
import { makeV2SyntheticNativeEligibility } from "./NativeCompatibility.runtime.fixture.ts";
import { V2ThreadToolsActivation } from "./PluginSetup.activation.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { digestV2EnrollmentOwner } from "./Orchestration.enrollment.record.ts";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";
import {
  v2ManagedPluginEntry,
  v2ManagedPluginFilename,
  v2PublicationProtocol,
} from "./PluginSetup.record.ts";
import { readV2NativePluginFile, v2NativePluginDirectory } from "./PluginSetup.fs.ts";
import { runV2RequestContext } from "./Client.guard.ts";
import type { OpencodeV2Client } from "./Client.ts";

const connection = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock("./SharedService.connection.ts", () => ({
  borrowV2SharedService: async () => ({ client: connection.client, close: async () => {} }),
}));

// Model the already installed local-Location bootstrap, not an installation freshly
// generated from the application under test. Only the native SDK/eligibility is synthetic.
it("keeps an installed local-Location bootstrap ready across remote-workspace app changes with retained owners", async () => {
  const render = Identity.renderV2ThreadIdentity;
  const oldIdentity = vi
    .spyOn(Identity, "renderV2ThreadIdentity")
    .mockImplementation((key) =>
      render(key).replace(
        "!bounded(owner.workspaceTargetId)",
        'owner.workspaceTargetId !== "local"',
      ),
    );
  const app = await makeV2ThreadPluginFixture().finally(() => oldIdentity.mockRestore());
  const f = await makeV2ActivationJobsFixture();
  let coordinator: V2ThreadToolsActivation | undefined;
  let dispose: (() => Promise<void>) | undefined;
  try {
    const root = path.join(app.root, "native-config");
    await mkdir(path.join(root, "plugins"), { recursive: true, mode: 0o700 });
    await Effect.runPromise(
      f.settings.updateSettings({ providers: { opencodeV2: { nativePluginConfigRoot: root } } }),
    );
    const installed = app.artifact;
    const preferred = await exportV2ThreadArtifact(app.root);
    const owner = app.bind("retained-native-history", root);
    const enrollments = await V2ThreadRecords.open(
      installed.root,
      "enrollments",
      installed.privateKey,
      installed.publicKey,
    );
    await enrollments.replace("retained-owner", undefined, {
      owner,
      digest: digestV2EnrollmentOwner(owner),
      state: "active",
      acknowledged: { revision: 1, expiry: Date.now() - 1000 },
      pending: null,
    });
    const ownersBefore = await enrollments.inventory();
    const filename = path.join(root, "plugins", v2ManagedPluginFilename(installed));
    const entry = v2ManagedPluginEntry(installed, root);
    await writeFile(filename, entry.content, { mode: 0o600 });
    const nativeFile = (await readV2NativePluginFile(filename, true))!;
    const installations = await V2ThreadRecords.open(
      installed.root,
      "installations",
      installed.privateKey,
      installed.publicKey,
    );
    await installations.replace(
      JSON.stringify([root, v2ManagedPluginFilename(installed)]),
      undefined,
      {
        protocol: v2PublicationProtocol(installed),
        root,
        phase: "committed",
        rootIdentity: await v2NativePluginDirectory(root),
        pluginsIdentity: await v2NativePluginDirectory(path.join(root, "plugins")),
        next: entry,
        nextIdentity: nativeFile.identity,
        previous: null,
        previousIdentity: null,
      },
    );
    const installationsBefore = await installations.inventory();
    const host = makeV2ThreadPluginHost(owner);
    dispose = await (
      await import(/* @vite-ignore */ installed.entryUri)
    ).default.setup(host.context);
    const active = vi.fn(async () => ({ unrelatedNativeWork: { type: "running" } }));
    const client = {
      config: { get: async () => [{ type: "directory", path: root }] },
      rpc: {
        call: async (input: { method: string; input: unknown }) => ({
          output: await host.call(input.method, input.input),
        }),
      },
      plugin: {
        list: async () => ({
          location: { directory: root },
          data: [
            {
              id: v2ThreadRegistration(installed).id,
              source: { type: "local", path: filename },
              state: { status: "active" },
            },
          ],
        }),
      },
      session: { active },
    } as unknown as OpencodeV2Client;
    connection.client = client;
    coordinator = new V2ThreadToolsActivation(
      f.settings,
      makeV2SyntheticNativeEligibility(client, preferred, root),
    );
    const setup = vi.spyOn(coordinator, "requestSetup");
    const permit = coordinator.consent.capture();
    try {
      const ready = await runV2RequestContext(
        { permit, transport: "synthetic-only", intent: "execute" },
        () =>
          coordinator!.awaitReady(
            preferred,
            {
              registrationFile: "synthetic-only",
              generation: "synthetic-native-generation",
              storageIdentity: "storage",
            },
            client,
            root,
          ),
      );
      expect(ready.stamp.bootstrapDigest).toBe(installed.artifactDigest);
      expect(preferred.artifactDigest).toBe(installed.artifactDigest);
      expect(setup).not.toHaveBeenCalled();
      expect(active).not.toHaveBeenCalled();
      expect(await enrollments.inventory()).toEqual(ownersBefore);
      expect(await installations.inventory()).toEqual(installationsBefore);
      expect(await readFile(filename, "utf8")).toBe(entry.content);
      expect((await stat(filename)).ino).toBe(nativeFile.identity.ino);
    } finally {
      permit.release();
    }
  } finally {
    await coordinator?.close();
    await dispose?.();
    f.consent.close();
    await app.close();
  }
});
