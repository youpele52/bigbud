import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import { makeResolveTerminalFolder } from "../terminal/Layers/Manager.cwd.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(!pickerProofOptedIn)(
  "validates an authorized terminal cwd over the owner with no legacy fallback",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const targetId = fixture.executionTargetId.replace("transport=agent", "transport=direct-ssh");
      const cwd = path.join(fixture.folder, "project dir");
      const escaped = path.join(fixture.folder, "symlink-dir");
      await mkdir(cwd);
      await symlink(fixture.home, escaped);
      const options = await proofOptions(fixture);
      await fixture.start();
      vi.stubEnv("PATH", fixture.env.PATH);
      vi.stubEnv("HOME", fixture.home);
      await storageScope(path.join(fixture.root, "terminal-cwd-proof.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            ...options,
            sql,
            targetId,
            workspaceRoot: fixture.folder,
          });
          try {
            const trust = await owner.inspectTrust();
            if (trust.state !== "approvalRequired") throw new Error("Expected fixture first use");
            await owner.approveTrust(trust.challenge);
            const probe = vi.fn(
              async (
                {
                  executionTargetId,
                  cwd,
                  home,
                }: { executionTargetId: string; cwd: string; home: boolean },
                signal: AbortSignal,
              ) => {
                signal.throwIfAborted();
                if (executionTargetId !== targetId || home)
                  throw new Error("The proof does not grant Home lookup");
                return { kind: "resolved" as const, cwd: await owner.probeProofTerminalCwd(cwd) };
              },
            );
            const resolve = makeResolveTerminalFolder(
              () => Effect.die("Local path must not run"),
              undefined,
              undefined,
              undefined,
              { probeCwd: probe },
            );
            const input = {
              executionTargetId: targetId,
              threadId: "proof",
              terminalId: "pane",
              cwd,
            };
            await expect(Effect.runPromise(resolve(input))).resolves.toMatchObject({ cwd });
            await vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(1));
            const before = fixture.connectionStarts();
            await expect(
              Effect.runPromise(resolve({ ...input, cwd: fixture.home })),
            ).rejects.toMatchObject({ _tag: "TerminalExecutionTargetError" });
            expect(fixture.connectionStarts()).toBe(before);
            await expect(
              Effect.runPromise(resolve({ ...input, cwd: escaped })),
            ).rejects.toMatchObject({ _tag: "TerminalExecutionTargetError" });
            await vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(2));
            await owner.disconnect();
            const disconnected = fixture.connectionStarts();
            await expect(Effect.runPromise(resolve(input))).rejects.toMatchObject({
              _tag: "TerminalExecutionTargetError",
            });
            expect(fixture.connectionStarts()).toBe(disconnected);
            expect(probe.mock.calls.map(([request]) => request.home)).toEqual([
              false,
              false,
              false,
              false,
            ]);
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
