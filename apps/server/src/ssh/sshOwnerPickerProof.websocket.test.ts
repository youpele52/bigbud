import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import type { ServerListRemoteFoldersInput } from "@bigbud/contracts/server/server.remoteFolders";
import { Effect, Layer } from "effect";
import { expect, it, vi } from "vitest";

import { buildAppUnderTest } from "../server.test.app.ts";
import { serverHttpTestLayer } from "../server.test.http.ts";
import { attemptRawUpgrade } from "../server.test.remote.ts";
import { getWsServerUrl, serverTestLayer, withWsRpcClient } from "../server.test.rpc.ts";
import {
  PickerProofOwnerError,
  startPickerProofOwner,
  type PickerProofOwner,
} from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

const listWithOwner = vi.hoisted(() => vi.fn<PickerProofOwner["listRemoteFolders"]>());

// Keep the production route, auth, upgrade, RPC group, handler and error mapping. Bind only the
// picker effect's existing listing dependency in this test file; normal startup never sees it.
vi.mock(import("../ws/wsRemoteFolders.ts"), async (load) => {
  const actual = await load();
  return {
    ...actual,
    listRemoteFoldersEffect: (input: ServerListRemoteFoldersInput) =>
      actual.listRemoteFoldersEffect(input, listWithOwner),
  };
});

it.skipIf(!pickerProofOptedIn)(
  "serves the Rust picker through the authenticated product WebSocket route without legacy fallback",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const options = await proofOptions(fixture);
      const authToken = randomUUID();
      const input = {
        executionTargetId: fixture.executionTargetId,
        path: `~/${path.basename(fixture.folder)}`,
      };
      // If legacy SSH is accidentally used, only the sandboxed loopback recorders are on PATH.
      vi.stubEnv("PATH", fixture.env.PATH);
      vi.stubEnv("HOME", fixture.home);
      await fixture.start();
      await storageScope(path.join(fixture.root, "websocket.sqlite"), (sql) =>
        Effect.gen(function* () {
          const owner = yield* Effect.acquireRelease(
            Effect.promise(() => startPickerProofOwner({ ...options, sql })),
            (owner) => Effect.promise(() => owner.close()),
          );
          listWithOwner.mockImplementation((request) => owner.listRemoteFolders(request));
          yield* buildAppUnderTest({ config: { authToken } });
          const wsUrl = yield* getWsServerUrl("/ws");

          const beforeDenied = fixture.connectionStarts();
          for (const url of [wsUrl, `${wsUrl}?token=wrong`]) {
            const outcome = yield* Effect.promise(() => attemptRawUpgrade(url)).pipe(
              Effect.timeout("5 seconds"),
            );
            expect(outcome).toMatchObject({ upgraded: false, status: 401 });
          }
          expect(listWithOwner).not.toHaveBeenCalled();
          expect(fixture.connectionStarts()).toBe(beforeDenied);

          yield* withWsRpcClient(`${wsUrl}?token=${authToken}`, (client) =>
            Effect.gen(function* () {
              const list = () => client[WS_METHODS.serverListRemoteFolders](input);
              const untrusted = yield* list().pipe(Effect.flip);
              expect(untrusted).toMatchObject({
                _tag: "ServerListRemoteFoldersError",
                message: new PickerProofOwnerError("trustRequired").message,
              });
              expect(fixture.acceptedPublicKeys()).toBe(0);

              // Trust is fixture setup through the private proof channel, not a product trust RPC.
              const trust = yield* Effect.promise(() => owner.inspectTrust());
              if (trust.state !== "approvalRequired") throw new Error("Expected first-use trust");
              yield* Effect.promise(() => owner.approveTrust(trust.challenge));
              expect(yield* list()).toEqual({
                path: fixture.folder,
                homePath: fixture.home,
                folders: [
                  { name: "alpha", isGitRepo: false },
                  { name: "Z repo", isGitRepo: true },
                ],
                truncated: false,
              });
              yield* Effect.promise(() =>
                vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(1)),
              );

              yield* Effect.promise(() => owner.killForTest());
              const afterDeath = fixture.connectionStarts();
              const unavailable = yield* list().pipe(Effect.flip);
              expect(unavailable).toMatchObject({
                _tag: "ServerListRemoteFoldersError",
                message: new PickerProofOwnerError("ownerUnavailable").message,
              });
              expect(fixture.connectionStarts()).toBe(afterDeath);
              expect(listWithOwner.mock.calls).toEqual([[input], [input], [input]]);
              expect(yield* Effect.promise(fixture.launchNames)).toEqual([]);
            }).pipe(Effect.timeout("45 seconds")),
          );
        }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverTestLayer, serverHttpTestLayer))),
      );
    } finally {
      listWithOwner.mockReset();
      vi.unstubAllEnvs();
      await fixture.dispose();
    }
  },
  120_000,
);

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "reuses the verified POSIX master through the product picker and retires it on Disconnect",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const options = await proofOptions(fixture, undefined, false, true);
      const authToken = randomUUID();
      const input = {
        executionTargetId: fixture.executionTargetId,
        path: `~/${path.basename(fixture.folder)}`,
      };
      vi.stubEnv("PATH", fixture.env.PATH);
      vi.stubEnv("HOME", fixture.home);
      await fixture.start();
      await storageScope(path.join(fixture.root, "picker-master.sqlite"), (sql) =>
        Effect.gen(function* () {
          const start = Effect.acquireRelease(
            Effect.promise(() =>
              startPickerProofOwner({ ...options, posixPickerMaster: true, sql }),
            ),
            (owner) => Effect.promise(() => owner.close()),
          );
          const first = yield* start;
          let current: PickerProofOwner = first;
          listWithOwner.mockImplementation((request) => current.listRemoteFolders(request));
          yield* buildAppUnderTest({ config: { authToken } });
          const wsUrl = yield* getWsServerUrl("/ws");
          yield* withWsRpcClient(`${wsUrl}?token=${authToken}`, (client) =>
            Effect.gen(function* () {
              const list = () => client[WS_METHODS.serverListRemoteFolders](input);
              const untrusted = yield* list().pipe(Effect.flip);
              expect(untrusted.message).toBe(new PickerProofOwnerError("trustRequired").message);
              expect(fixture.connectionStarts()).toBe(0);
              const trust = yield* Effect.promise(() => first.inspectTrust());
              if (trust.state !== "approvalRequired")
                throw new Error("Expected a fixture approval");
              yield* Effect.promise(() => first.approveTrust(trust.challenge));
              const listed = yield* list();
              expect(listed).toMatchObject({
                path: fixture.folder,
                folders: [{ name: "alpha" }, { name: "Z repo" }],
              });
              expect(yield* list()).toEqual(listed);
              yield* Effect.promise(() =>
                vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(1)),
              );
              yield* Effect.promise(() => first.disconnect());
              const baseline = fixture.connectionStarts();
              expect((yield* list().pipe(Effect.flip)).message).toBe(
                new PickerProofOwnerError("targetDisconnected").message,
              );
              yield* Effect.promise(() => first.close());
              current = yield* start;
              expect((yield* list().pipe(Effect.flip)).message).toBe(
                new PickerProofOwnerError("targetDisconnected").message,
              );
              expect(fixture.connectionStarts()).toBe(baseline);
              yield* Effect.promise(() => current.connect());
              expect(yield* list()).toEqual(listed);
              yield* Effect.promise(() =>
                vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(2)),
              );
              expect(yield* Effect.promise(fixture.launchNames)).toEqual([]);
            }).pipe(Effect.timeout("45 seconds")),
          );
        }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverTestLayer, serverHttpTestLayer))),
      );
    } finally {
      listWithOwner.mockReset();
      vi.unstubAllEnvs();
      await fixture.dispose();
    }
  },
  120_000,
);

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "requires a new Connect after the active master loses its pinned trust",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const options = await proofOptions(fixture, undefined, false, true);
      const authToken = randomUUID();
      const input = {
        executionTargetId: fixture.executionTargetId,
        path: `~/${path.basename(fixture.folder)}`,
      };
      const file = fixture.knownHosts;
      const pin = `${fixture.host} ${fixture.hostPublicKey}\n`;
      await writeFile(file, pin, { mode: 0o600 });
      vi.stubEnv("PATH", fixture.env.PATH);
      vi.stubEnv("HOME", fixture.home);
      await fixture.start();
      await storageScope(path.join(fixture.root, "picker-master-trust-fault.sqlite"), (sql) =>
        Effect.gen(function* () {
          const owner = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startPickerProofOwner({ ...options, posixPickerMaster: true, sql }),
            ),
            (owner) => Effect.promise(() => owner.close()),
          );
          listWithOwner.mockImplementation((request) => owner.listRemoteFolders(request));
          yield* buildAppUnderTest({ config: { authToken } });
          const wsUrl = yield* getWsServerUrl("/ws");
          yield* withWsRpcClient(`${wsUrl}?token=${authToken}`, (client) =>
            Effect.gen(function* () {
              const list = () => client[WS_METHODS.serverListRemoteFolders](input);
              const first = yield* list();
              expect(first.path).toBe(fixture.folder);
              yield* Effect.promise(() =>
                vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(1)),
              );
              const baseline = fixture.connectionStarts();
              const changed = new PickerProofOwnerError("hostKeyChanged").message;
              yield* Effect.promise(() =>
                writeFile(file, `${fixture.host} ${fixture.wrongPublicKey}\n`),
              );
              expect((yield* list().pipe(Effect.flip)).message).toBe(changed);
              yield* Effect.promise(() => writeFile(file, pin));
              expect((yield* list().pipe(Effect.flip)).message).toBe(changed);
              expect(fixture.connectionStarts()).toBe(baseline);
              expect(fixture.acceptedPublicKeys()).toBe(1);
              yield* Effect.promise(() => owner.connect());
              expect(yield* list()).toEqual(first);
              yield* Effect.promise(() =>
                vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(2)),
              );
              expect(yield* Effect.promise(fixture.launchNames)).toEqual([]);
            }).pipe(Effect.timeout("45 seconds")),
          );
        }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverTestLayer, serverHttpTestLayer))),
      );
    } finally {
      listWithOwner.mockReset();
      vi.unstubAllEnvs();
      await fixture.dispose();
    }
  },
  120_000,
);
