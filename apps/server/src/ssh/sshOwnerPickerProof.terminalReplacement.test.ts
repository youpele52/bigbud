import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it, vi } from "vitest";
import { makeRemoteAgentRuntimeBindings } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import type { RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import { makeNativeDirectSshTerminal } from "../terminal-host/localTerminalHost.directSsh.owner.ts";
import type { PtySpawnInput } from "../terminal/Services/PTY.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makePickerProofTerminalAdapter } from "./sshOwnerPickerProof.terminalAdapter.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(!pickerProofOptedIn)(
  "replaces only a confirmed exited native terminal on explicit restart",
  async () => {
    const fixture = await makeLoopbackPickerFixture({ allowPty: true });
    try {
      const options = await proofOptions(fixture, undefined, true);
      const targetId = options.targetId.replace("transport=agent", "transport=direct-ssh");
      const binaryPath = path.join(fixture.root, "picker-owner");
      const sha256 = createHash("sha256")
        .update(await readFile(binaryPath))
        .digest("hex");
      const runtime: RemoteAgentRuntime = {
        generation: "picker-proof",
        version: "0.1.0",
        sha256,
        buildDigest: sha256,
        targetTriple:
          process.arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl",
        origin: "legacy-external",
        binaryPath,
        statePath: fixture.root,
        socketPath: path.join(fixture.root, "supervisor.sock"),
        logPath: path.join(fixture.root, "supervisor.log"),
      };
      await fixture.start();
      vi.stubEnv("HOME", fixture.home);
      vi.stubEnv("PATH", fixture.env.PATH);
      await storageScope(path.join(fixture.root, "replacement.sqlite"), (sql) =>
        Effect.promise(async () => {
          const store = await Effect.runPromise(
            makeRemoteAgentRuntimeBindings.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
          );
          const owner = await startPickerProofOwner({
            ...options,
            targetId,
            sql,
            workspaceRoot: fixture.folder,
          });
          try {
            const trust = await owner.inspectTrust();
            if (trust.state !== "approvalRequired")
              throw new Error("Expected isolated first-use trust.");
            await owner.approveTrust(trust.challenge);
            const build = () =>
              makeNativeDirectSshTerminal(
                {
                  port: makePickerProofTerminalAdapter(owner, targetId).port,
                  owners: () => store,
                  runtime,
                },
                (target) => target === targetId,
                () => false,
              );
            const pane = JSON.stringify(["replacement-thread", "replacement-pane"]);
            const input: PtySpawnInput = {
              ownerKey: pane,
              executionTargetId: targetId,
              remoteCwd: fixture.folder,
              cwd: fixture.home,
              shell: "/unused",
              args: [],
              env: {},
              cols: 80,
              rows: 24,
            };
            const first = build();
            const original = await Effect.runPromise(first.spawn(input));
            const route = await store.get(`terminal:${pane}`);
            if (!route) throw new Error("Missing original route.");
            try {
              await expect(
                Effect.runPromise(build().spawn({ ...input, replaceTerminalOwner: true })),
              ).rejects.toThrow("not confirmed stopped");
              expect((await store.get(route.ownerKey))?.resourceId).toBe(route.resourceId);
              await original.prepareRestart!();
              expect((await store.get(route.ownerKey))?.state).toBe("terminal");
              const replacement = await Effect.runPromise(
                build().spawn({ ...input, replaceTerminalOwner: true }),
              );
              try {
                expect(replacement.remoteResourceId).not.toBe(route.resourceId);
                expect(replacement.recovered).toBe(false);
                expect((await store.get(route.ownerKey))?.resourceId).toBe(
                  replacement.remoteResourceId,
                );
                await expect(
                  first.runtimeForTarget(targetId)!.localSshClient!.close(route),
                ).rejects.toThrow("stays reserved");
                expect((await store.get(route.ownerKey))?.resourceId).toBe(
                  replacement.remoteResourceId,
                );
                await replacement.prepareRestart!();
                expect((await store.get(route.ownerKey))?.state).toBe("terminal");
              } finally {
                replacement.detach?.();
              }
            } finally {
              original.detach?.();
            }
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
