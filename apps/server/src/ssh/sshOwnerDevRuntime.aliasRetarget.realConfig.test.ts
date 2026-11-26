import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SshHostTrustChallenge } from "@bigbud/contracts/server/server.sshHostTrust";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it, vi } from "vitest";

import { activateDevSshOwner } from "./sshOwnerDevMode.fixture.ts";
import { DEV_OWNER_SSH_CONFIG } from "./sshOwnerDevRuntime.profileConfig.ts";
import { makeDevSshOwnerRuntime } from "./sshOwnerDevRuntime.ts";
import { pickerProofOptedIn, storageScope } from "./sshOwnerPickerProof.integration.ts";
import type { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";
import { SSH_HOST_TRUST_REQUIRED_PREFIX } from "./sshTargetUnavailable.ts";

const alias = "dev-workbench";

async function makeProfile() {
  const root = await mkdtemp("/private/tmp/bigbud-ssh-owner-dev-");
  await writeFile(
    path.join(root, DEV_OWNER_SSH_CONFIG),
    [
      `Host !prod-* ${alias}`,
      "  Include host-key.conf",
      "  Include fixture-endpoint.conf",
      "  IdentitiesOnly yes",
      "Host *",
      "  ConnectTimeout 4",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await writeHostKey(root, "workbench-trust");
  return root;
}

async function writeHostKey(root: string, value: string) {
  await writeFile(path.join(root, "host-key.conf"), `HostKeyAlias ${value}\n`, { mode: 0o600 });
}

type Session = Omit<
  Extract<Effect.Success<ReturnType<typeof makeDevSshOwnerRuntime>>, { kind: "unix" }>,
  "fixture"
> & { readonly fixture: Awaited<ReturnType<typeof makeLoopbackPickerFixture>> };

function withRuntime<A>(
  profile: string,
  sql: SqlClient.SqlClient,
  body: (s: Session) => Promise<A>,
) {
  vi.stubEnv("BIGBUD_SSH_OWNER_NORMAL_DEV_PROFILE", profile);
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* makeDevSshOwnerRuntime();
        if (session?.kind !== "unix" || !("connectionStarts" in session.fixture))
          throw new Error("Expected the disposable macOS runtime");
        return yield* Effect.promise(() => body(session as Session));
      }),
    ).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
  );
}

async function trustAndList(session: Session, input: { executionTargetId: string; path: string }) {
  const first = await session.picker.listRemoteFolders(input).then(
    () => {
      throw new Error("Expected a first-use trust challenge");
    },
    (error: Error) => error,
  );
  expect(first.message.startsWith(SSH_HOST_TRUST_REQUIRED_PREFIX)).toBe(true);
  const { challengeId } = Schema.decodeUnknownSync(SshHostTrustChallenge)(
    JSON.parse(first.message.slice(SSH_HOST_TRUST_REQUIRED_PREFIX.length)),
  );
  await session.picker.trustSshHost({ executionTargetId: input.executionTargetId, challengeId });
  return session.picker.listRemoteFolders(input);
}

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "revalidates a saved alias from a real-shaped config before any dial",
  async () => {
    const profile = await makeProfile();
    try {
      vi.stubEnv(
        "BIGBUD_SSH_OWNER_BIN",
        process.env.BIGBUD_SSH_OWNER_PICKER_PROOF_BIN ??
          fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url)),
      );
      activateDevSshOwner();
      await storageScope(path.join(profile, "state.sqlite"), (sql) =>
        Effect.promise(async () => {
          const rows = () =>
            Effect.runPromise(sql<{ scope: string; digest: string }>`
              SELECT profile_scope AS scope, descriptor_digest AS digest
              FROM ssh_alias_descriptor_bindings ORDER BY profile_scope`);
          const saved = await withRuntime(profile, sql, async (session) => {
            expect(session.alias).toBe(alias);
            const input = { executionTargetId: session.targetId, path: session.fixture.folder };
            const folders = await trustAndList(session, input);
            await session.picker.verifyExecutionTarget({ ...input, cwd: folders.path });
            return { input, cwd: folders.path };
          });
          const [binding] = await rows();
          expect(binding?.digest).toMatch(/^[0-9a-f]{64}$/);

          // A changed HostKeyAlias in an included file changes the destination trust identity.
          await writeHostKey(profile, "workbench-trust-v2");
          await withRuntime(profile, sql, async (session) => {
            const input = { executionTargetId: saved.input.executionTargetId, path: saved.cwd };
            for (const attempt of [
              session.picker.listRemoteFolders(input),
              session.picker.inspectTrust(input),
              session.picker.verifyExecutionTarget({ ...input, cwd: saved.cwd }),
            ]) {
              await expect(attempt).rejects.toThrow(/changed since this workspace was saved/);
            }
            await expect(session.picker.listRemoteFolders(input)).rejects.toMatchObject({
              code: "sshAliasChanged",
            });
            expect(session.fixture.connectionStarts()).toBe(0);
            expect(await session.fixture.launchNames()).toEqual([]);
            expect(await rows()).toEqual([binding]);

            // Only an explicit Connect re-approves the exact descriptor already presented.
            await session.picker.connectExecutionTarget(input);
            expect(session.fixture.connectionStarts()).toBe(0);
            const [reapproved] = await rows();
            expect(reapproved?.digest).not.toBe(binding?.digest);
            await expect(
              trustAndList(session, { ...input, path: session.fixture.folder }),
            ).resolves.toMatchObject({ path: session.fixture.folder });

            // A second change is refused again rather than inheriting the approval.
            await writeHostKey(profile, "workbench-trust-v3");
          });
          await withRuntime(profile, sql, async (session) => {
            const input = { executionTargetId: saved.input.executionTargetId, path: saved.cwd };
            await expect(session.picker.listRemoteFolders(input)).rejects.toMatchObject({
              code: "sshAliasChanged",
            });
            expect(session.fixture.connectionStarts()).toBe(0);
            expect(await session.fixture.launchNames()).toEqual([]);
          });
          expect((await rows()).map((row) => row.scope)).toEqual([await realpath(profile)]);
        }),
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(profile, { recursive: true, force: true });
    }
  },
  120_000,
);
