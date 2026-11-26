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

const alias = "laptop-workbench";

async function makeProfile() {
  const root = await mkdtemp("/private/tmp/bigbud-ssh-owner-dev-");
  await writeFile(
    path.join(root, DEV_OWNER_SSH_CONFIG),
    `Host ${alias}\n  Include fixture-endpoint.conf\n  IdentitiesOnly yes\n`,
    { mode: 0o600 },
  );
  return root;
}

type Session = Omit<
  Extract<Effect.Success<ReturnType<typeof makeDevSshOwnerRuntime>>, { kind: "unix" }>,
  "fixture"
> & { readonly fixture: Awaited<ReturnType<typeof makeLoopbackPickerFixture>> };

/** One full dev runtime (fresh fixture endpoint and native owner) on the shared SQLite file. */
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
  "refuses a saved alias whose effective descriptor changed until Connect re-approves it, per profile",
  async () => {
    const profileA = await makeProfile();
    const profileB = await makeProfile();
    try {
      vi.stubEnv(
        "BIGBUD_SSH_OWNER_BIN",
        process.env.BIGBUD_SSH_OWNER_PICKER_PROOF_BIN ??
          fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url)),
      );
      activateDevSshOwner();
      await storageScope(path.join(profileA, "shared-state.sqlite"), (sql) =>
        Effect.promise(async () => {
          const rows = () =>
            Effect.runPromise(sql<{ scope: string; digest: string }>`
              SELECT profile_scope AS scope, descriptor_digest AS digest
              FROM ssh_alias_descriptor_bindings ORDER BY profile_scope`);
          const saved = await withRuntime(profileA, sql, async (session) => {
            const input = { executionTargetId: session.targetId, path: session.fixture.folder };
            const folders = await trustAndList(session, input);
            await session.picker.verifyExecutionTarget({ ...input, cwd: folders.path });
            return { input, cwd: folders.path };
          });
          const [binding] = await rows();
          expect(binding?.digest).toMatch(/^[0-9a-f]{64}$/);

          // A fresh endpoint (port, trust file) under the same alias is a different descriptor.
          await withRuntime(profileA, sql, async (session) => {
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

            await session.picker.connectExecutionTarget(input);
            expect(session.fixture.connectionStarts()).toBe(0);
            const [reapproved] = await rows();
            expect(reapproved?.digest).not.toBe(binding?.digest);
            await expect(
              trustAndList(session, { ...input, path: session.fixture.folder }),
            ).resolves.toMatchObject({ path: session.fixture.folder });
          });

          // Another profile sharing the database starts unbound for the same alias and target.
          await withRuntime(profileB, sql, async (session) => {
            const input = { executionTargetId: session.targetId, path: session.fixture.folder };
            expect(session.targetId).toBe(saved.input.executionTargetId);
            const folders = await trustAndList(session, input);
            await session.picker.verifyExecutionTarget({ ...input, cwd: folders.path });
          });
          const scopes = await Promise.all([realpath(profileA), realpath(profileB)]);
          expect((await rows()).map((row) => row.scope)).toEqual(scopes.toSorted());
        }),
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(profileA, { recursive: true, force: true });
      await rm(profileB, { recursive: true, force: true });
    }
  },
  120_000,
);
