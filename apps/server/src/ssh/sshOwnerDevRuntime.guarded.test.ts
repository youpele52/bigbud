import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { SshHostTrustChallenge } from "@bigbud/contracts/server/server.sshHostTrust";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEV_SSH_OWNER_GUARDED_APPROVAL,
  DEV_SSH_OWNER_GUARDED_MARKER,
  supportsDevSshOwnerGuardedFixture,
  DEV_SSH_OWNER_PROFILE_PREFIX,
} from "@bigbud/shared/DevLauncher";
import { Effect, Layer, Schema } from "effect";
import { expect, it, vi } from "vitest";
import type { WorkspaceRuntimeShape } from "../workspace-runtime/Services/WorkspaceRuntime.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { makeWsSshOwnerDevHandlers } from "../ws/wsSshOwnerDev.ts";
import { withWsSshOwnerDevWorkspace } from "../ws/wsSshOwnerDev.workspace.ts";
import { activateDevSshOwner } from "./sshOwnerDevMode.fixture.ts";
import { DevSshOwnerRuntime, makeDevSshOwnerRuntime } from "./sshOwnerDevRuntime.ts";
import { pickerProofOptedIn, storageScope } from "./sshOwnerPickerProof.integration.ts";
import { SSH_HOST_TRUST_REQUIRED_PREFIX } from "./sshTargetUnavailable.ts";

const sha = (data: string) => createHash("sha256").update(data).digest("hex");
const supported = await supportsDevSshOwnerGuardedFixture();

it.skipIf(!supported || !pickerProofOptedIn)(
  "qualifies and saves through the selected development Files composition",
  async () => {
    const profile = await mkdtemp(`/tmp/${DEV_SSH_OWNER_PROFILE_PREFIX}`);
    try {
      vi.stubEnv("BIGBUD_SSH_OWNER_NORMAL_DEV_PROFILE", profile);
      vi.stubEnv(
        "BIGBUD_SSH_OWNER_BIN",
        process.env.BIGBUD_SSH_OWNER_PICKER_PROOF_BIN ??
          fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url)),
      );
      await writeFile(
        path.join(profile, DEV_SSH_OWNER_GUARDED_MARKER),
        DEV_SSH_OWNER_GUARDED_APPROVAL,
        {
          mode: 0o600,
          flag: "wx",
        },
      );
      activateDevSshOwner();
      await storageScope(path.join(profile, "state.sqlite"), (sql) =>
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* makeDevSshOwnerRuntime();
            if (session?.kind !== "unix") throw new Error("Expected a disposable Unix fixture");
            const selected = yield* makeWsSshOwnerDevHandlers().pipe(
              Effect.provideService(DevSshOwnerRuntime, { session }),
            );
            if (!selected?.workspace) throw new Error("Expected a selected workspace");
            const { handlers, workspace } = selected;
            expect(workspace).not.toHaveProperty("guardedWrite");
            const { fixture, targetId: executionTargetId } = session;
            const trustInput = { executionTargetId, path: fixture.folder };
            const challenge = yield* Effect.flip(
              handlers[WS_METHODS.serverListRemoteFolders](trustInput),
            );
            expect(challenge.message.startsWith(SSH_HOST_TRUST_REQUIRED_PREFIX)).toBe(true);
            const { challengeId } = Schema.decodeUnknownSync(SshHostTrustChallenge)(
              JSON.parse(challenge.message.slice(SSH_HOST_TRUST_REQUIRED_PREFIX.length)),
            );
            yield* handlers[WS_METHODS.serverTrustSshHost]({ ...trustInput, challengeId });
            expect(
              yield* handlers[WS_METHODS.serverVerifyExecutionTarget]({
                executionTargetId,
                cwd: fixture.folder,
              }),
            ).toMatchObject({ executionTargetId, cwd: fixture.folder });
            const fallback = () => Effect.die("Unexpected workspace fallback");
            const original: WorkspaceRuntimeShape = {
              files: {
                listDirectory: fallback,
                readFilePreview: fallback,
                readFileRange: fallback,
                writeFile: fallback,
              },
              search: { searchEntries: fallback, searchFileContents: fallback },
              watch: { watchDirectory: fallback },
            };
            const { files } = yield* withWsSshOwnerDevWorkspace(original, workspace).pipe(
              Effect.provide(WorkspacePathsLive.pipe(Layer.provide(NodeServices.layer))),
            );
            const input = { executionTargetId, cwd: fixture.folder, relativePath: "draft.txt" };
            const file = path.join(input.cwd, input.relativePath);
            yield* Effect.promise(() => writeFile(file, "base\n", { flag: "wx" }));
            const preview = yield* files.readFilePreview(input);
            expect(preview).toMatchObject({ sha256: sha("base\n"), edit: { mode: "guarded" } });
            const contents = "café\r\n";
            const save = {
              ...input,
              contents,
              expectedSha256: sha("base\n"),
              operationId: "app-save",
            };
            expect(yield* files.writeFile(save)).toEqual({
              relativePath: input.relativePath,
              resultSha256: sha(contents),
            });
            expect(
              yield* Effect.flip(files.writeFile({ ...save, operationId: "app-stale" })),
            ).toMatchObject({
              conflict: true,
              currentSha256: sha(contents),
            });
            expect(yield* Effect.promise(() => readFile(file, "utf8"))).toBe(contents);
            expect(yield* Effect.promise(() => readdir(input.cwd))).not.toEqual(
              expect.arrayContaining([expect.stringMatching(/^\.(guarded-qualification|bigbud-)/)]),
            );
            const rows = yield* sql<{
              operation_id: string;
            }>`SELECT operation_id FROM dev_ssh_guarded_write_journal`;
            expect(rows.map(({ operation_id }) => operation_id)).toEqual(
              expect.arrayContaining(["app-save", "app-stale"]),
            );
          }),
        ),
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(profile, { recursive: true, force: true });
    }
  },
  90_000,
);
