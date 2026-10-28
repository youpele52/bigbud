import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { vi } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { makeV2PreviousBootstrapFixture } from "./Orchestration.bootstrap.previous.fixture.ts";
import { makeV2ThreadPluginHost } from "./Orchestration.plugin.host.fixture.ts";
import { makeV2ActivationJobsFixture } from "./PluginSetup.activation.jobs.fixture.ts";
import { makeV2SyntheticNativeEligibility } from "./NativeCompatibility.runtime.fixture.ts";
import { assertV2RuntimeBootstrap } from "./NativeCompatibility.qualification.ts";
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

/** Signed real previous-current modules/publication; only the native host/transport are synthetic. */
export async function makeV2RetainedActivationFixture() {
  const app = await makeV2ThreadPluginFixture();
  const f = await makeV2ActivationJobsFixture();
  const preferred = app.artifact;
  const installed = await makeV2PreviousBootstrapFixture(preferred);
  const root = path.join(app.root, "native-config");
  await mkdir(path.join(root, "plugins"), { recursive: true, mode: 0o700 });
  await Effect.runPromise(
    f.settings.updateSettings({ providers: { opencodeV2: { nativePluginConfigRoot: root } } }),
  );
  const owner = {
    ...app.bind("retained-native-history", root),
    bootstrapDigest: installed.artifactDigest,
    bootstrapAbi: installed.bootstrapAbi,
    compatibilityDigest: installed.compatibilityDigest,
  };
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
  const key = JSON.stringify([root, v2ManagedPluginFilename(installed)]);
  const publication = {
    protocol: v2PublicationProtocol(installed),
    root,
    phase: "committed" as const,
    rootIdentity: await v2NativePluginDirectory(root),
    pluginsIdentity: await v2NativePluginDirectory(path.join(root, "plugins")),
    next: entry,
    nextIdentity: nativeFile.identity,
    previous: null,
    previousIdentity: null,
  };
  await installations.replace(key, undefined, publication);
  const host = makeV2ThreadPluginHost(owner);
  host.context.app.version = "2.2.0";
  const dispose = await (
    await import(/* @vite-ignore */ installed.entryUri)
  ).default.setup(host.context);
  const session = { active: vi.fn(), create: vi.fn(), update: vi.fn(), prompt: vi.fn() };
  const plugins = [
    {
      id: v2ThreadRegistration(installed).id,
      source: { type: "local", path: filename },
      state: { status: "active" },
    },
  ];
  const config: unknown[] = [
    { type: "document", info: {} },
    { type: "directory", path: root },
  ];
  const rpc = vi.fn(async (input: { method: string; input: unknown }) => ({
    output: await host.call(input.method, input.input),
  }));
  const client = {
    config: { get: async () => config },
    rpc: { call: rpc },
    plugin: { list: async () => ({ location: { directory: root }, data: plugins }) },
    session,
  } as unknown as OpencodeV2Client;
  const synthetic = makeV2SyntheticNativeEligibility(
    client,
    preferred,
    root,
    "2.2.0",
    "v2-system-global-config-v1",
  );
  const eligibility = vi.fn(async (...args: Parameters<typeof synthetic>) => {
    const proof = await synthetic(...args);
    assertV2RuntimeBootstrap(proof.nativeVersion, args[0]);
    return proof;
  });
  const coordinator = new V2ThreadToolsActivation(f.settings, eligibility);
  const setup = vi.spyOn(coordinator, "requestSetup");
  const descriptor = {
    registrationFile: "synthetic-only",
    generation: "synthetic-native-generation",
    storageIdentity: "storage",
  };
  const permit = coordinator.consent.capture();
  const run = <T>(action: () => Promise<T>) =>
    runV2RequestContext(
      { permit, transport: descriptor.registrationFile, intent: "execute" },
      action,
    );
  return {
    app,
    f,
    preferred,
    installed,
    root,
    owner,
    filename,
    entry,
    nativeFile,
    enrollments,
    installations,
    key,
    publication,
    host,
    plugins,
    config,
    rpc,
    client,
    eligibility,
    coordinator,
    setup,
    descriptor,
    permit,
    run,
    ready: () => run(() => coordinator.awaitReady(preferred, descriptor, client, root)),
    async close() {
      permit.release();
      await coordinator.close();
      await dispose();
      f.consent.close();
      await app.close();
    },
  };
}
