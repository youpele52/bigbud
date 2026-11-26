import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it, vi } from "vitest";

import { makeRemoteAgentRuntimeBindings } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import { makeSshOwnerDevPicker } from "./sshOwnerDevPicker.ts";
import { bindDevOwnerAlias } from "./sshOwnerDevRuntime.profileConfig.ts";
import { makeSshOwnerDevTerminal } from "./sshOwnerDevTerminal.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(!pickerProofOptedIn)(
  "keeps an interactive terminal lease alive across FD3 snapshot cancellation",
  async () => {
    const fixture = await makeLoopbackPickerFixture({
      allowInteractiveShell: true,
      authenticationGate: true,
    });
    const gate = fixture.authGate;
    try {
      if (!gate) throw new Error("Expected an authentication gate");
      const options = await proofOptions(fixture, undefined, true);
      const { aliasConfig } = await bindDevOwnerAlias(
        fixture,
        "proof-terminal-snapshot",
        undefined,
      );
      if (!aliasConfig) throw new Error("Expected macOS fixture alias config");
      const binaryPath = path.join(fixture.root, "picker-owner");
      const sha256 = createHash("sha256")
        .update(await readFile(binaryPath))
        .digest("hex");
      const targetId = options.targetId.replace("transport=agent", "transport=direct-ssh");
      const ownerKey = JSON.stringify(["interactive-thread", "interactive-pane"]);
      const routeKey = `terminal:${ownerKey}`;
      await fixture.start();
      vi.stubEnv("HOME", fixture.home);
      vi.stubEnv("PATH", fixture.env.PATH);
      await storageScope(path.join(fixture.root, "interactive.sqlite"), (sql) =>
        Effect.gen(function* () {
          const store = yield* makeRemoteAgentRuntimeBindings.pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          const picker = makeSshOwnerDevPicker({
            executionTargetId: targetId,
            host: fixture.host,
            startOwner: (profileBinding) =>
              startPickerProofOwner({
                ...options,
                aliasConfig,
                devInteractiveTerminal: true,
                posixWorkspaceSnapshotCancellation: true,
                profileBinding,
                sql,
                targetId,
                workspaceRoot: fixture.folder,
              }),
          });
          yield* Effect.acquireRelease(Effect.void, () => Effect.promise(picker.close));
          const { wrapPtyAdapter, preflight } = makeSshOwnerDevTerminal({
            targetId,
            workspaceRoot: fixture.folder,
            withOwner: picker.withOwner,
            owners: () => store,
            runtime: {
              generation: "dev-interactive-fixture",
              version: "0.1.0",
              sha256,
              buildDigest: sha256,
              targetTriple:
                process.arch === "arm64"
                  ? "aarch64-unknown-linux-musl"
                  : "x86_64-unknown-linux-musl",
              origin: "legacy-external",
              binaryPath,
              statePath: fixture.root,
              socketPath: path.join(fixture.root, "supervisor.sock"),
              logPath: path.join(fixture.root, "supervisor.log"),
            },
          });
          const fallback = vi.fn(() => Effect.die("legacy fallback was called"));
          const adapter = wrapPtyAdapter({ spawn: fallback });
          yield* Effect.promise(async (signal) => {
            const trust = await picker.inspectTrust({ executionTargetId: targetId });
            if (trust.state !== "approvalRequired") throw new Error("Expected first-use trust");
            await picker.trustSshHost({
              executionTargetId: targetId,
              challengeId: trust.challenge.challengeId,
            });
            await expect(preflight(targetId, fixture.folder, signal)).resolves.toBe(fixture.folder);
          });
          const pty = yield* adapter.spawn({
            ownerKey,
            executionTargetId: targetId,
            remoteCwd: fixture.folder,
            shell: "/nonexistent/legacy-ssh",
            cwd: fixture.home,
            env: {},
            cols: 80,
            rows: 24,
          });
          yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => pty.detach?.()));
          yield* Effect.promise(async () => {
            let output = "";
            const error = vi.fn();
            const exit = vi.fn();
            pty.onData((data) => {
              output += data;
            });
            pty.onError?.(error);
            pty.onExit(exit);
            pty.write("printf '<%s>\\n' ready\r");
            await vi.waitFor(() => expect(output).toMatch(/\r?\n<ready>\r?\n/), { timeout: 5_000 });
            await gate.arm();
            const controller = new AbortController();
            const snapshot = picker.withOwner(targetId, (owner) =>
              owner.snapshotProofWorkspaceDirectory(
                { executionTargetId: targetId, workspaceRoot: fixture.folder, relativeDir: "" },
                controller.signal,
              ),
            );
            const outcome = snapshot.catch((error: unknown) => error);
            try {
              await vi.waitFor(async () => expect(await gate.isHeld()).toBe(true), {
                timeout: 5_000,
              });
              controller.abort();
              expect(await outcome).toMatchObject({ code: "listCancelled" });
              expect(exit).not.toHaveBeenCalled();
            } finally {
              controller.abort();
              await gate.release();
            }
            pty.resize(97, 31);
            pty.write("printf '<%s>\\n' \"$((6 * 7))\"; pwd; stty size; exit\r");
            await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce(), { timeout: 10_000 });
            expect(output).toMatch(/\r?\n<42>\r?\n/);
            expect(output).toContain(fixture.folder);
            expect(output).toMatch(/\r?\n31 97\r?\n/);
            expect(error).not.toHaveBeenCalled();
            expect(fallback).not.toHaveBeenCalled();
            expect(await store.get(routeKey)).toMatchObject({
              state: "terminal",
              resourceId: pty.remoteResourceId,
            });
          });
        }).pipe(Effect.scoped),
      );
    } finally {
      vi.unstubAllEnvs();
      await fixture.dispose();
    }
  },
);
