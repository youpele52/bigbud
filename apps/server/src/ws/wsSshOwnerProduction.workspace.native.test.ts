import { createHash } from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { expect, it } from "vitest";

import {
  readExternalV2Target,
  withProductionV2Owner,
} from "../provider/Layers/OpencodeV2/ServerManager.sshOwner.production.native.fixture.ts";
import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import { unsupportedWorkspaceMutations } from "../workspace-runtime/Services/WorkspaceMutations.ts";
import type { WorkspaceRuntimeShape } from "../workspace-runtime/Services/WorkspaceRuntime.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { withWsSshOwnerProductionWorkspace } from "./wsSshOwnerProduction.workspace.ts";

// W2 T-files live proof: a real target-free `bigbud-ssh-owner --production`
// (macOS or Linux initiator) against an already-running disposable sshd. The
// remote `cwd` must be an empty directory holding a symlink `escape` that
// points outside it. Same target JSON shape as the OpenCode production test:
// BIGBUD_TEST_SSH_OWNER_PRODUCTION_FILES_TARGET='{"host":…,"port":…,"user":…,
//   "identityFile":…,"knownHostsFile":…,"cwd":…,"remoteBinary":"/unused"}'
const external = readExternalV2Target(process.env.BIGBUD_TEST_SSH_OWNER_PRODUCTION_FILES_TARGET);
const enabled =
  external !== undefined && (process.platform === "darwin" || process.platform === "linux");
const pathsLayer = WorkspacePathsLive.pipe(Layer.provide(NodeServices.layer));
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

it.skipIf(!enabled)(
  "serves production Files over the live owner: 512 KiB staged write, folder ops and refusals",
  async () => {
    await withProductionV2Owner(
      external!,
      1,
      async ({ handle, targets }) => {
        const [target] = targets;
        const { descriptor, cwd } = target!;
        const bound = handle.target(descriptor);
        const trust = await bound.inspectTrust();
        if (trust.state === "approvalRequired") await bound.approveTrust(trust.challenge);
        const registration = {
          handle,
          descriptorFor: async () => descriptor,
        } as unknown as SshOwnerProductionRegistration;
        const refuse = () => Effect.die(new Error("the default runtime must never be reached"));
        const base: WorkspaceRuntimeShape = {
          files: {
            listDirectory: refuse,
            readFilePreview: refuse,
            readFileRange: refuse,
            writeFile: refuse,
          },
          search: { searchEntries: refuse, searchFileContents: refuse },
          watch: { watchDirectory: refuse },
        };
        const composed = withWsSshOwnerProductionWorkspace(
          { workspaceRuntime: base, workspaceMutations: unsupportedWorkspaceMutations },
          { read: () => registration },
        )!;
        const files = Effect.runSync(composed.workspaceRuntime.pipe(Effect.provide(pathsLayer)));
        const mutations = composed.workspaceMutations;
        const input = { executionTargetId: descriptor.targetId, cwd };
        const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
        const flip = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect));

        // Single-frame write, then a staged 512 KiB unguarded write (11 chunks).
        await run(files.files.writeFile({ ...input, relativePath: "small.txt", contents: "hi\n" }));
        const big = "abcdefgh".repeat(64 * 1024);
        await run(files.files.writeFile({ ...input, relativePath: "big.txt", contents: big }));
        const range = await run(
          files.files.readFileRange({
            ...input,
            relativePath: "big.txt",
            offset: 0,
            maxBytes: 512 * 1024,
          }),
        );
        expect(range.sizeBytes).toBe(big.length);
        expect(sha(range.bytes)).toBe(sha(big));
        // One byte over the owner bound never leaves the server.
        expect(
          await flip(
            files.files.writeFile({ ...input, relativePath: "big.txt", contents: `${big}!` }),
          ),
        ).toMatchObject({ writeDisposition: "not-dispatched" });
        const preview = await run(
          files.files.readFilePreview({ ...input, relativePath: "small.txt" }),
        );
        expect(preview).toMatchObject({ contents: "hi\n", relativePath: "small.txt" });

        // Folder create and permanent delete with typed terminal outcomes.
        const actions = await run(mutations.entryActions(input));
        expect(actions.createFolder.allowed).toBe(true);
        await run(mutations.createDirectory({ ...input, relativePath: "made" }));
        expect(
          await flip(mutations.createDirectory({ ...input, relativePath: "made" })),
        ).toMatchObject({ writeDisposition: "terminal" });
        const listing = await run(files.files.listDirectory(input));
        expect(listing.entries.map((entry) => entry.path).toSorted()).toEqual(
          expect.arrayContaining(["big.txt", "made", "small.txt"]),
        );
        await run(
          mutations.deleteEntry({ ...input, relativePath: "made", expectedKind: "directory" }),
        );
        await run(
          mutations.deleteEntry({ ...input, relativePath: "small.txt", expectedKind: "file" }),
        );
        expect(
          await flip(
            mutations.deleteEntry({ ...input, relativePath: "small.txt", expectedKind: "file" }),
          ),
        ).toMatchObject({ writeDisposition: "terminal" });

        // New File: exclusive create on the target; a second create is terminal.
        const created = { ...input, relativePath: "new.txt", contents: "n\n", createOnly: true };
        await run(files.files.writeFile(created));
        expect(await flip(files.files.writeFile(created))).toMatchObject({
          writeDisposition: "terminal",
        });
        await run(
          mutations.deleteEntry({ ...input, relativePath: "new.txt", expectedKind: "file" }),
        );

        // The owner refuses a symlink escape and a root of `/`; a guarded save is
        // refused before dispatch rather than downgraded.
        for (const relativePath of ["escape/child.txt", "escape"]) {
          const exit = await Effect.runPromiseExit(
            files.files.writeFile({ ...input, relativePath, contents: "x" }),
          );
          expect(Exit.isFailure(exit)).toBe(true);
        }
        expect(await flip(files.files.listDirectory({ ...input, cwd: "/" }))).toMatchObject({
          _tag: "WorkspaceEntriesError",
        });
        expect(
          await flip(
            files.files.writeFile({
              ...input,
              relativePath: "big.txt",
              contents: "x",
              expectedSha256: sha(big),
            }),
          ),
        ).toMatchObject({ writeDisposition: "not-dispatched" });
        const after = await run(
          files.files.readFileRange({ ...input, relativePath: "big.txt", offset: 0, maxBytes: 8 }),
        );
        expect(new TextDecoder().decode(after.bytes)).toBe("abcdefgh");
      },
      { binding: {} },
    );
  },
  120_000,
);
