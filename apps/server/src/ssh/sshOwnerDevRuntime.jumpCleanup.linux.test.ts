import { execFile } from "node:child_process";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Effect } from "effect";
import { expect, it } from "vitest";

import { bindLinuxDevJump } from "./sshOwnerDevRuntime.jump.ts";
import { storageScope } from "./sshOwnerPickerProof.integration.ts";

const approved =
  process.platform === "linux" &&
  process.env.BIGBUD_TEST_JUMP_STORAGE === "approved-disposable" &&
  process.getuid?.() !== 0;
const runner = fileURLToPath(
  new URL("../../../../protocol/ssh-owner/live-jump-fixture.sh", import.meta.url),
);
const run = promisify(execFile);

it.skipIf(!approved)("refuses a non-fixture root without writing into it", async () => {
  const outside = await mkdtemp("/tmp/bigbud-jump-rejected-");
  try {
    await expect(
      run("/bin/sh", [runner, "--serve", outside, "/usr/bin/true"], {
        env: { BIGBUD_SSH_OWNER_LIVE_JUMP: "approved-disposable", PATH: "/usr/bin:/bin" },
        timeout: 5_000,
      }),
    ).rejects.toMatchObject({ code: 1 });
    expect(await readdir(outside)).toEqual([]);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

it.skipIf(!approved)(
  "cleans the fixture and launcher on graceful scope close with an active route",
  async () => {
    const binary = process.env.BIGBUD_SSH_OWNER_PICKER_PROOF_BIN;
    if (!binary || !path.isAbsolute(binary))
      throw new Error("Expected an absolute Linux owner binary.");
    const profile = await mkdtemp("/tmp/bigbud-ssh-owner-dev-");
    const launcher = path.join(profile, "ssh-owner-jump-launcher");
    try {
      await storageScope(path.join(profile, "storage.sqlite"), (sql) =>
        Effect.gen(function* () {
          const root = yield* Effect.scoped(
            Effect.gen(function* () {
              const bound = yield* Effect.acquireRelease(
                Effect.promise(() => bindLinuxDevJump(profile, binary, sql)),
                (fixture) => Effect.promise(fixture.close),
              );
              return yield* Effect.promise(async () => {
                expect(
                  await bound.picker.listRemoteFolders({ executionTargetId: bound.targetId }),
                ).toMatchObject({
                  folders: [{ name: "jump-fixture-folder", isGitRepo: false }],
                });
                const root = bound.fixture.root;
                expect(
                  (await readdir(root)).filter((name) => name.startsWith("bbcm-")),
                ).toHaveLength(2);
                for (const identity of ["b-identity", "d-identity"]) {
                  expect((await lstat(path.join(root, identity))).isFile()).toBe(true);
                }
                expect((await lstat(launcher)).isFile()).toBe(true);
                return root;
              });
            }),
          );
          yield* Effect.promise(async () => {
            await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
            await expect(lstat(launcher)).rejects.toMatchObject({ code: "ENOENT" });
          });
        }),
      );
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  },
  60_000,
);
