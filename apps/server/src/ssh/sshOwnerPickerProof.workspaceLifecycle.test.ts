import { execFileSync } from "node:child_process";
import { mkdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Stream } from "effect";
import { expect, it, vi } from "vitest";

import { WorkspaceEntries } from "../workspace/Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "../workspace/Services/WorkspaceFileSystem.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { workspaceForOwner } from "./sshOwnerPickerProof.workspace.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(!pickerProofOptedIn)(
  "routes isolated workspace name search, polling snapshots and bounded writes through the Rust owner",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const cwd = path.join(fixture.folder, "workspace lifecycle");
      const watchDir = path.join(cwd, "watched");
      const watched = path.join(watchDir, "fixture-tracked.txt");
      const outside = path.join(fixture.home, "outside-write-target.txt");
      await mkdir(watchDir, { recursive: true });
      await writeFile(watched, "one!");
      await utimes(watched, 1_700_000_500.125, 1_700_000_500.125);
      await writeFile(path.join(cwd, ".gitignore"), "fixture-ignored.txt\n");
      await writeFile(path.join(cwd, "fixture-ignored.txt"), "ignored supplied.( fixture");
      await writeFile(outside, "unchanged");
      await symlink(outside, path.join(cwd, "escape.txt"));
      const git = (...args: string[]) =>
        execFileSync("/usr/bin/git", args, {
          cwd,
          env: {
            HOME: fixture.home,
            PATH: "/usr/bin:/bin",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
          },
          stdio: "ignore",
        });
      git("init", "-q");
      git("add", "--", ".gitignore", "watched/fixture-tracked.txt");

      const executionTargetId = fixture.executionTargetId.replace(
        "transport=agent",
        "transport=direct-ssh",
      );
      const options = await proofOptions(fixture);
      await fixture.start();
      vi.stubEnv("HOME", fixture.home);
      vi.stubEnv("PATH", fixture.env.PATH);
      await storageScope(path.join(fixture.root, "workspace-lifecycle-proof.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            ...options,
            sql,
            targetId: executionTargetId,
            workspaceRoot: cwd,
          });
          try {
            const trust = await owner.inspectTrust();
            if (trust.state !== "approvalRequired")
              throw new Error("Expected isolated first-use trust");
            await owner.approveTrust(trust.challenge);
            await Effect.runPromise(
              Effect.gen(function* () {
                const files = yield* WorkspaceFileSystem;
                const entries = yield* WorkspaceEntries;
                const target = { executionTargetId, cwd };
                const results = yield* entries.search({ ...target, query: "fixture", limit: 10 });
                expect(results.entries.map(({ path }) => path)).toEqual([
                  "watched/fixture-tracked.txt",
                ]);
                expect(results.truncated).toBe(false);

                const watch = yield* files.watchDirectory({ ...target, relativePath: "watched" });
                let received = 0;
                const events = yield* Stream.runCollect(
                  watch.pipe(
                    Stream.tap((event) =>
                      Effect.promise(async () => {
                        expect(event.type).toBe("directoryChanged");
                        if (received++ === 0) {
                          await writeFile(watched, "two!");
                          await utimes(watched, 1_700_000_500.625, 1_700_000_500.625);
                        }
                      }),
                    ),
                    Stream.take(2),
                  ),
                ).pipe(Effect.timeout("10 seconds"));
                expect(events.map(({ type, generation }) => [type, generation])).toEqual([
                  ["directoryChanged", 1],
                  ["directoryChanged", 2],
                ]);

                const relativePath = "watched/created ; 'proof'.txt";
                const contents = "owner supplied.( stdin café\n";
                expect(yield* files.writeFile({ ...target, relativePath, contents })).toEqual({
                  relativePath,
                });
                expect(
                  yield* Effect.promise(() => readFile(path.join(cwd, relativePath), "utf8")),
                ).toBe(contents);
                const big = "x".repeat(512 * 1024);
                const bigPath = "watched/large.txt";
                expect(
                  yield* files.writeFile({ ...target, relativePath: bigPath, contents: big }),
                ).toEqual({ relativePath: bigPath });
                expect(yield* Effect.promise(() => readFile(path.join(cwd, bigPath), "utf8"))).toBe(
                  big,
                );
                const oversize = yield* Effect.result(
                  files.writeFile({
                    ...target,
                    relativePath: bigPath,
                    contents: `${big}y`,
                  }),
                );
                expect(oversize).toMatchObject({
                  _tag: "Failure",
                  failure: { writeDisposition: "not-dispatched" },
                });
                expect(yield* Effect.promise(() => readFile(path.join(cwd, bigPath), "utf8"))).toBe(
                  big,
                );
                const largeWatch = yield* files.watchDirectory({
                  ...target,
                  relativePath: "watched",
                });
                const largeEvents = yield* Stream.runCollect(
                  largeWatch.pipe(
                    Stream.tap(() =>
                      Effect.promise(() => writeFile(path.join(cwd, bigPath), `${big}!`)),
                    ),
                    Stream.take(2),
                  ),
                ).pipe(Effect.timeout("10 seconds"));
                expect(largeEvents.map(({ type }) => type)).toEqual([
                  "directoryChanged",
                  "directoryChanged",
                ]);
                const changed = yield* entries.search({ ...target, query: "created", limit: 10 });
                expect(changed.entries.map(({ path }) => path)).toEqual([relativePath]);
                const matches = yield* files.searchFileContents({
                  ...target,
                  query: "SUPPLIED.(",
                  limit: 10,
                });
                expect(matches).toEqual({
                  matches: [
                    { path: relativePath, line: 1, column: 7, lineText: contents.trimEnd() },
                  ],
                  truncated: false,
                  notice: "use-managed-agent",
                });

                const deniedSymlink = yield* Effect.result(
                  files.writeFile({ ...target, relativePath: "escape.txt", contents }),
                );
                expect(deniedSymlink).toMatchObject({
                  _tag: "Failure",
                  failure: { cause: { code: "workspacePathDenied" } },
                });
                expect(yield* Effect.promise(() => readFile(outside, "utf8"))).toBe("unchanged");
                const beforeGuard = fixture.connectionStarts();
                const unsupported = yield* Effect.result(
                  files.writeFile({ ...target, relativePath, contents, createOnly: true }),
                );
                expect(unsupported).toMatchObject({
                  _tag: "Failure",
                  failure: { writeDisposition: "not-dispatched" },
                });
                expect(fixture.connectionStarts()).toBe(beforeGuard);

                const create = (relativePath: string, contents: string) =>
                  Effect.promise(() =>
                    owner.createProofWorkspaceFile({
                      executionTargetId,
                      workspaceRoot: cwd,
                      relativePath,
                      contents: new TextEncoder().encode(contents),
                    }),
                  );
                const exclusive = "watched/exclusive ; 'proof'.txt";
                expect(yield* create(exclusive, "first")).toBe("created");
                expect(yield* create(exclusive, "second")).toBe("alreadyExists");
                expect(yield* create("escape.txt", "replacement")).toBe("alreadyExists");
                expect(
                  yield* Effect.promise(() => readFile(path.join(cwd, exclusive), "utf8")),
                ).toBe("first");
                expect(yield* Effect.promise(() => readFile(outside, "utf8"))).toBe("unchanged");

                yield* Effect.promise(() => owner.disconnect());
                const attempts = fixture.connectionStarts();
                const disconnected = yield* Effect.result(
                  entries.search({ ...target, query: "fixture", limit: 10 }),
                );
                expect(disconnected).toMatchObject({
                  _tag: "Failure",
                  failure: { cause: { code: "targetDisconnected" } },
                });
                const pausedWatch = yield* files.watchDirectory({
                  ...target,
                  relativePath: "watched",
                });
                const gap = yield* Stream.runCollect(Stream.take(pausedWatch, 1)).pipe(
                  Effect.timeout("5 seconds"),
                );
                expect(gap).toMatchObject([{ type: "rescanRequired", reason: "transportLost" }]);
                expect(fixture.connectionStarts()).toBe(attempts);
                yield* Effect.promise(() => owner.killForTest());
                const unavailable = yield* Effect.result(
                  files.writeFile({ ...target, relativePath, contents: "no fallback" }),
                );
                expect(unavailable).toMatchObject({
                  _tag: "Failure",
                  failure: { cause: { code: "ownerUnavailable" } },
                });
                expect(fixture.connectionStarts()).toBe(attempts);
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
