import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeWsSshOwnerDevHandlers } from "../ws/wsSshOwnerDev.ts";
import { activateDevSshOwner } from "./sshOwnerDevMode.ts";
import { resolveProfileAliases } from "./sshConfigProfileAliases.ts";
import { startPickerProofOwner, type PickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";
import { DevSshOwnerRuntime } from "./sshOwnerDevRuntime.ts";

let fixture: Awaited<ReturnType<typeof makeLoopbackPickerFixture>>;
let owner: PickerProofOwner | undefined;
let aliasFile: string;

beforeEach(async () => {
  fixture = await makeLoopbackPickerFixture();
  activateDevSshOwner();
  aliasFile = path.join(fixture.root, "owner-alias.conf");
  const marker = path.join(fixture.root, "executed");
  await writeFile(
    aliasFile,
    [
      "Host !prod-* build-box",
      `  HostName ${fixture.loopback}`,
      `  Port ${fixture.port}`,
      "  Include host-key.conf",
      "Host blocked",
      `  HostName ${fixture.loopback}`,
      `  Port ${fixture.port}`,
      `  LocalCommand touch ${marker}`,
      "Host *",
      `  User ${fixture.user}`,
      `  IdentityFile ${fixture.identity}`,
      `  UserKnownHostsFile ${fixture.knownHosts}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await writeFile(path.join(fixture.root, "host-key.conf"), "HostKeyAlias fixture-trust\n", {
    mode: 0o600,
  });
  await chmod(aliasFile, 0o600);
  await fixture.start();
});

afterEach(async () => {
  await owner?.close().catch(() => undefined);
  owner = undefined;
  await fixture.dispose();
  vi.unstubAllEnvs();
});

async function startAliasOwner(sql: Parameters<typeof startPickerProofOwner>[0]["sql"]) {
  const options = await proofOptions(fixture);
  const started = await startPickerProofOwner({
    ...options,
    aliasConfig: { file: aliasFile, alias: "build-box" },
    sql,
  });
  owner = started;
  return started;
}

describe("owner listAliases", () => {
  it.skipIf(!pickerProofOptedIn)(
    "lists ordered alias metadata over the selected WebSocket/RPC path without connecting",
    async () => {
      await storageScope(path.join(fixture.root, "aliases.sqlite"), (sql) =>
        Effect.gen(function* () {
          const started = yield* Effect.promise(() => startAliasOwner(sql));
          const session = {
            kind: "unix",
            alias: "build-box",
            targetId: fixture.executionTargetId,
            fixture,
            picker: {
              withOwner: <A>(
                _executionTargetId: string,
                operation: (client: PickerProofOwner) => Promise<A>,
              ) => operation(started),
              listRemoteFolders: async () => {
                throw new Error("not used");
              },
              verifyExecutionTarget: async () => {
                throw new Error("not used");
              },
              trustSshHost: async () => {
                throw new Error("not used");
              },
              unlockSshKey: async () => {
                throw new Error("not used");
              },
              unlockSshPassword: async () => {
                throw new Error("not used");
              },
              connectExecutionTarget: async () => {
                throw new Error("not used");
              },
              disconnectExecutionTarget: async () => {
                throw new Error("not used");
              },
              close: async () => undefined,
            },
            sql,
            terminal: undefined,
          };
          const selected = yield* Effect.promise(() =>
            Effect.runPromise(
              makeWsSshOwnerDevHandlers().pipe(
                Effect.provideService(DevSshOwnerRuntime, { session } as never),
              ),
            ),
          );
          if (!selected) throw new Error("Expected the selected handlers");
          const before = fixture.connectionStarts();
          const hosts = yield* selected.handlers[WS_METHODS.serverListSshConfigHosts]();

          expect(hosts.hosts.map((host) => host.alias)).toEqual(["build-box", "blocked"]);
          expect(hosts.hosts[0]).toMatchObject({
            alias: "build-box",
            hostName: fixture.loopback,
            port: String(fixture.port),
            user: fixture.user,
            hostKeyAlias: "fixture-trust",
            route: "direct",
            supported: true,
          });
          expect(hosts.hosts[1]).toMatchObject({
            alias: "blocked",
            supported: false,
            unsupportedReason: expect.stringContaining("directive"),
          });
          // Listing is metadata only: no SSH connection and no LocalCommand process.
          expect(fixture.connectionStarts()).toBe(before);
          expect(yield* Effect.promise(() => fixture.launchNames())).toEqual([]);
          yield* Effect.promise(() =>
            expect(readFile(path.join(fixture.root, "executed"))).rejects.toMatchObject({
              code: "ENOENT",
            }),
          );
        }),
      );
    },
    60_000,
  );

  it.skipIf(!pickerProofOptedIn)(
    "matches the previous TypeScript resolver on the same fixture",
    async () => {
      await storageScope(path.join(fixture.root, "parity.sqlite"), (sql) =>
        Effect.gen(function* () {
          const started = yield* Effect.promise(() => startAliasOwner(sql));
          const aliases = yield* Effect.promise(() => started.listAliases());
          const content = yield* Effect.promise(() => readFile(aliasFile, "utf8"));
          const previous = yield* Effect.promise(() =>
            resolveProfileAliases({ root: fixture.root, sourcePath: aliasFile, content }),
          );
          expect(aliases.entries.map((entry) => entry.alias)).toEqual(
            previous.hints.map((hint) => hint.alias),
          );
          for (const entry of aliases.entries.filter((item) => !item.unsupported)) {
            const hint = previous.hints.find((item) => item.alias === entry.alias);
            expect(entry).toMatchObject({
              hostName: hint?.hostName,
              user: hint?.user,
              port: Number(hint?.port),
              ...(hint?.hostKeyAlias ? { hostKeyAlias: hint.hostKeyAlias } : {}),
            });
          }
        }),
      );
    },
    60_000,
  );
});
