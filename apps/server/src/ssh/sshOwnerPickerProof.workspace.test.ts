import { createHash } from "node:crypto";
import { mkdir, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import { WorkspaceEntries } from "../workspace/Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "../workspace/Services/WorkspaceFileSystem.ts";
import { WORKSPACE_FILE_PREVIEW_MAX_BYTES } from "../workspace/WorkspaceFilePreview.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { workspaceForOwner } from "./sshOwnerPickerProof.workspace.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(!pickerProofOptedIn)(
  "isolated workspace feature lists and reads through the real Rust owner without falling back",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const workspaceRoot = fixture.folder;
      const name = "report; apostrophe's file.txt";
      const text = "﻿fixture café\r\n";
      const binary = Uint8Array.from([0, 255, 1, 13, 10, 128, 2, 3]);
      await writeFile(path.join(workspaceRoot, name), text);
      await writeFile(path.join(workspaceRoot, "data.bin"), binary);
      await writeFile(path.join(workspaceRoot, "oversize.txt"), "");
      await truncate(
        path.join(workspaceRoot, "oversize.txt"),
        WORKSPACE_FILE_PREVIEW_MAX_BYTES + 1,
      );
      await writeFile(
        path.join(workspaceRoot, "at-limit.txt"),
        Buffer.alloc(WORKSPACE_FILE_PREVIEW_MAX_BYTES, 0x61),
      );
      await writeFile(path.join(fixture.home, "outside.txt"), "not in the approved workspace");
      await symlink(path.join(fixture.home, "outside.txt"), path.join(workspaceRoot, "escape.txt"));
      await symlink(fixture.home, path.join(workspaceRoot, "escape-dir"));
      await mkdir(path.join(workspaceRoot, "node_modules"));
      await writeFile(path.join(workspaceRoot, "Z repo", "-entry ; 'quoted'.txt"), "fixture");
      const executionTargetId = fixture.executionTargetId.replace(
        "transport=agent",
        "transport=direct-ssh",
      );
      const options = await proofOptions(fixture);
      await fixture.start();
      // Any regressions into legacy SSH resolve the fixture recorder, not the ambient client.
      vi.stubEnv("PATH", fixture.env.PATH);
      vi.stubEnv("HOME", fixture.home);
      await storageScope(path.join(fixture.root, "workspace-proof.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            ...options,
            targetId: executionTargetId,
            workspaceRoot,
            sql,
          });
          try {
            const observation = await owner.inspectTrust();
            if (observation.state !== "approvalRequired")
              throw new Error("Expected an unpinned host");
            await owner.approveTrust(observation.challenge);
            const base = { executionTargetId, cwd: workspaceRoot };
            await Effect.runPromise(
              Effect.gen(function* () {
                const workspace = yield* WorkspaceFileSystem;
                const directory = yield* WorkspaceEntries;
                const rootEntries = (yield* directory.listDirectory(base)).entries;
                expect(rootEntries.map((entry) => entry.path)).toEqual([
                  ".hidden",
                  "alpha",
                  "Z repo",
                  "at-limit.txt",
                  "data.bin",
                  "not a folder",
                  "oversize.txt",
                  name,
                ]);
                expect(rootEntries.slice(0, 3).every((entry) => entry.kind === "directory")).toBe(
                  true,
                );
                expect(
                  yield* directory.listDirectory({ ...base, relativePath: "./Z repo/" }),
                ).toEqual({
                  entries: [
                    { path: "Z repo/.git", kind: "directory", parentPath: "Z repo" },
                    { path: "Z repo/-entry ; 'quoted'.txt", kind: "file", parentPath: "Z repo" },
                  ],
                });
                const symbolicDir = yield* Effect.result(
                  directory.listDirectory({ ...base, relativePath: "escape-dir" }),
                );
                expect(symbolicDir).toMatchObject({
                  _tag: "Failure",
                  failure: { cause: { code: "workspacePathDenied" } },
                });
                const beforeBadListing = fixture.connectionStarts();
                const traversal = yield* Effect.result(
                  directory.listDirectory({ ...base, relativePath: ".." }),
                );
                expect(traversal._tag).toBe("Failure");
                const wrongRoot = yield* Effect.result(
                  directory.listDirectory({ ...base, cwd: fixture.home }),
                );
                expect(wrongRoot).toMatchObject({
                  _tag: "Failure",
                  failure: { cause: { code: "workspacePathDenied" } },
                });
                expect(fixture.connectionStarts()).toBe(beforeBadListing);

                expect(yield* workspace.readFilePreview({ ...base, relativePath: name })).toEqual({
                  relativePath: name,
                  contents: text,
                  sizeBytes: Buffer.byteLength(text),
                  truncated: false,
                  sha256: createHash("sha256").update(text).digest("hex"),
                });
                expect(
                  yield* workspace.readFileRange({
                    ...base,
                    relativePath: "data.bin",
                    offset: 1,
                    maxBytes: 3,
                  }),
                ).toEqual({
                  relativePath: "data.bin",
                  bytes: binary.slice(1, 4),
                  sizeBytes: binary.length,
                  truncated: true,
                });
                expect(
                  yield* workspace.readFileRange({
                    ...base,
                    relativePath: "data.bin",
                    offset: binary.length,
                    maxBytes: 3,
                  }),
                ).toEqual({
                  relativePath: "data.bin",
                  bytes: new Uint8Array(),
                  sizeBytes: binary.length,
                  truncated: false,
                });
                const escaped = yield* Effect.result(
                  workspace.readFilePreview({ ...base, relativePath: "escape.txt" }),
                );
                expect(escaped).toMatchObject({
                  _tag: "Failure",
                  failure: { cause: { code: "workspacePathDenied" } },
                });
                const atLimit = yield* workspace.readFilePreview({
                  ...base,
                  relativePath: "at-limit.txt",
                });
                expect(atLimit.sizeBytes).toBe(WORKSPACE_FILE_PREVIEW_MAX_BYTES);
                expect(atLimit.contents.length).toBe(WORKSPACE_FILE_PREVIEW_MAX_BYTES);
                expect(atLimit.truncated).toBe(false);
                const huge = yield* Effect.result(
                  workspace.readFilePreview({ ...base, relativePath: "oversize.txt" }),
                );
                expect(huge).toMatchObject({
                  _tag: "Failure",
                  failure: { cause: { code: "workspaceFileTooLarge" } },
                });
                const outside = yield* Effect.result(
                  workspace.readFilePreview({
                    ...base,
                    cwd: fixture.home,
                    relativePath: "outside.txt",
                  }),
                );
                expect(outside).toMatchObject({
                  _tag: "Failure",
                  failure: { cause: { code: "workspacePathDenied" } },
                });
                yield* Effect.promise(() => owner.disconnect());
                const attemptsBefore = fixture.connectionStarts();
                const disconnected = yield* Effect.result(
                  workspace.readFileRange({
                    ...base,
                    relativePath: "data.bin",
                    offset: 0,
                    maxBytes: 1,
                  }),
                );
                expect(disconnected).toMatchObject({
                  _tag: "Failure",
                  failure: { cause: { code: "targetDisconnected" } },
                });
                const disconnectedList = yield* Effect.result(directory.listDirectory(base));
                expect(disconnectedList).toMatchObject({
                  _tag: "Failure",
                  failure: { cause: { code: "targetDisconnected" } },
                });
                expect(fixture.connectionStarts()).toBe(attemptsBefore);
                yield* Effect.promise(() => owner.killForTest());
                const unavailable = yield* Effect.result(
                  workspace.readFilePreview({ ...base, relativePath: name }),
                );
                expect(unavailable).toMatchObject({
                  _tag: "Failure",
                  failure: { cause: { code: "ownerUnavailable" } },
                });
                const unavailableList = yield* Effect.result(directory.listDirectory(base));
                expect(unavailableList).toMatchObject({
                  _tag: "Failure",
                  failure: { cause: { code: "ownerUnavailable" } },
                });
                expect(fixture.connectionStarts()).toBe(attemptsBefore);
              }).pipe(Effect.provide(workspaceForOwner(owner, fixture.root))),
            );
            expect(await fixture.launchNames()).toEqual([]);
          } finally {
            await owner.close();
          }
        }),
      );
    } finally {
      vi.unstubAllEnvs();
      await fixture.dispose();
    }
  },
  120_000,
);
