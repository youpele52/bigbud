import { mkdir, lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";
import { readV2SharedRegistration } from "./SharedService.registration.ts";
import { makeOwnedClient } from "./Client.ts";
import { exportV2ThreadArtifact } from "./Orchestration.artifact.ts";
import {
  readV2LifecycleCounters,
  writeV2LifecycleProbes,
} from "./Orchestration.lifecycle.native.fixture.ts";
import { V2ThreadImplementationRegistry } from "./Orchestration.implementation.ts";
import type { V2PureAction, V2PureJson } from "./Orchestration.implementation.types.ts";
import { deferred } from "./Test.fixtures.ts";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";
import { v2NativeRegistrationMetadata } from "./Runtime.registration.ts";

const binary = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY;
/** Boundary qualification only: real native bootstrap/crypto/executors, immutable broker handlers and owned fake canonical result. */
it.skipIf(!binary)(
  "compatible broker B does not reload bootstrap/suffix in two native Locations; captured A call survives selection/renewal and B behaves differently",
  async () => {
    const registry = new V2ThreadImplementationRegistry();
    const pinnedA = registry.acquire();
    const entered = deferred<void>(),
      release = deferred<void>();
    const leaseA = { revision: 1, expiry: Date.now() + 50000 };
    const a = await makeV2ThreadPluginFixture({
      responseLease: () => leaseA,
      invoke: async (value) => {
        const prepared = pinnedA.handler.prepare({
          action: value.action as V2PureAction,
          input: value.input as Record<string, V2PureJson>,
          callerThreadId: "caller-A",
        });
        entered.resolve();
        await release.promise;
        return pinnedA.handler.interpret({
          action: value.action as V2PureAction,
          canonicalResult: { ok: true, requestedLimit: prepared.limit ?? 200 },
        });
      },
    });
    let probes: Awaited<ReturnType<typeof writeV2LifecycleProbes>> | undefined;
    const native = await sharedServiceNativeFixture(binary!, async (file) => {
      probes = await writeV2LifecycleProbes(file);
    });
    let b: Awaited<ReturnType<typeof makeV2ThreadPluginFixture>> | undefined;
    try {
      const endpoint = (await readV2SharedRegistration(native.file)).endpoint;
      const client = makeOwnedClient({ endpoint: endpoint.url, password: endpoint.auth!.password });
      expect((await client.server.info()).version).toBe(
        process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION,
      );
      const second = path.join(native.profile, "second-location");
      await mkdir(second);
      const locations = [native.workspace, second];
      const selected = v2ThreadRegistration(a.artifact);
      const metadata = v2NativeRegistrationMetadata({
        registrationFamily: "scoped",
        profileIssuer: a.artifact.issuer,
      });
      const shim = path.join(probes!.directory, selected.filename);
      await writeFile(shim, `export {default} from ${JSON.stringify(a.artifact.entryUri)};\n`, {
        mode: 0o600,
        flag: "wx",
      });
      const info = (directory: string) =>
        client.rpc.call(
          { rpcID: selected.id, method: "info", input: {}, location: { directory } },
          { signal: AbortSignal.timeout(5000) },
        );
      for (const directory of locations)
        await expect
          .poll(() => info(directory), { timeout: 15000 })
          .toMatchObject({ output: { artifactDigest: a.artifact.artifactDigest } });
      const first = await client.session.create({
        id: "ses_stable_A",
        model: { providerID: "bigbud-v2-fixture", id: "synthetic-model" },
        location: { directory: native.workspace },
        metadata: {
          bigbud_provider: "opencodeV2",
          bigbud_thread: "disposable-canonical-thread",
          bigbud_storage: "disposable-storage",
          ...metadata,
        },
      });
      const ownerA = a.bind(first.id, native.workspace);
      const rpc = (directory: string, method: string, input: ReturnType<typeof a.envelope>) =>
        client.rpc.call(
          {
            rpcID: selected.id,
            method,
            input: JSON.parse(JSON.stringify(input)),
            location: { directory },
          },
          { signal: AbortSignal.timeout(5000) },
        );
      const expiryA = leaseA.expiry;
      await rpc(native.workspace, "enroll", a.envelope("enroll", 1, expiryA));
      const beforeShim = await lstat(shim),
        bytes = await readFile(shim);
      const before = await Promise.all(
        locations.map((directory) => readV2LifecycleCounters(client, directory)),
      );
      native.state.tool = selected.tool("list_threads");
      native.state.input = {};
      await client.session.prompt({
        sessionID: first.id,
        id: "msg_stable_A",
        text: "Owned synthetic list request A",
        files: [],
      });
      await entered.promise;
      registry.select("v2");
      const pinnedB = registry.acquire();
      b = await makeV2ThreadPluginFixture({
        stateRoot: a.root,
        implementationVersion: "v2",
        invoke: async (value) => {
          const body = pinnedB.handler.prepare({
            action: value.action as V2PureAction,
            input: value.input as Record<string, V2PureJson>,
            callerThreadId: "caller-B",
          });
          return pinnedB.handler.interpret({
            action: value.action as V2PureAction,
            canonicalResult: { ok: true, requestedLimit: body.limit ?? 200 },
          });
        },
      });
      expect((await exportV2ThreadArtifact(a.root)).artifactDigest).toBe(a.artifact.artifactDigest);
      expect(b.artifact.artifactDigest).toBe(a.artifact.artifactDigest);
      await rpc(native.workspace, "renew", a.envelope("renew", 2, expiryA + 1000));
      leaseA.revision = 2;
      leaseA.expiry = expiryA + 1000;
      expect(a.envelope("inspect").ownerDigest).toBe(a.envelope("enroll", 1, expiryA).ownerDigest);
      const next = await client.session.create({
        id: "ses_stable_B",
        model: { providerID: "bigbud-v2-fixture", id: "synthetic-model" },
        location: { directory: second },
        metadata: {
          bigbud_provider: "opencodeV2",
          bigbud_thread: "disposable-canonical-thread",
          bigbud_storage: "disposable-storage",
          ...metadata,
        },
      });
      b.bind(next.id, second);
      await rpc(second, "enroll", b.envelope("enroll", 1, Date.now() + 50000));
      release.resolve();
      await client.session.prompt({
        sessionID: next.id,
        id: "msg_stable_B",
        text: "Owned synthetic list request B",
        files: [],
      });
      await expect
        .poll(async () => JSON.stringify(await client.message.list({ sessionID: first.id })), {
          timeout: 15000,
        })
        .toContain('requestedLimit\\\":200');
      await expect
        .poll(async () => JSON.stringify(await client.message.list({ sessionID: next.id })), {
          timeout: 15000,
        })
        .toContain("bounded-list-v2");
      for (const [index, directory] of locations.entries())
        expect(await readV2LifecycleCounters(client, directory)).toEqual(before[index]);
      expect(await readFile(shim)).toEqual(bytes);
      expect((await lstat(shim)).ino).toBe(beforeShim.ino);
      expect((await lstat(shim)).mtimeMs).toBe(beforeShim.mtimeMs);
      expect(ownerA.enrollmentNonce).toBe(a.envelope("inspect").enrollmentNonce);
      pinnedB.release();
    } finally {
      release.resolve();
      await native.close();
      await b?.close();
      await a.close();
      pinnedA.release();
    }
  },
  60000,
);
