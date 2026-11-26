import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { expect, it } from "vitest";

import { startOwnedPiRpcProcess } from "../provider/Layers/Pi/RpcProcess.owner.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import { storageScope } from "./sshOwnerPickerProof.integration.ts";
import { makeLinuxLoopbackPickerFixture } from "./sshPicker.loopback.fixture.linux.ts";

const live = process.platform === "linux" && process.env.BIGBUD_TEST_SSH_OWNER_PICKER_PROOF === "1";

// Fixed protocol recorder, not a Pi installation or provider account.
const source = String.raw`
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    puts("pi v0.99.0");
    return 0;
  }
  if (argc != 3 || strcmp(argv[1], "--mode") != 0 || strcmp(argv[2], "rpc") != 0) return 2;
  const char *home = getenv("HOME");
  char cwd[4096], request[4096];
  if (!home || !getcwd(cwd, sizeof cwd) || strcmp(home,cwd) != 0 || getenv("SSH_AUTH_SOCK")) return 3;
  fputs("synthetic Pi ready\n",stderr);
  fflush(stderr);
  if (!fgets(request, sizeof request, stdin) || !strstr(request,"get_state")) return 4;
  puts("{\"id\":\"fixture\",\"type\":\"response\",\"command\":\"get_state\",\"success\":true}");
  fputs("synthetic Pi diagnostic\n",stderr);
  return 0;
}
`;

it.skipIf(!live).each(["eof", "cancel"] as const)(
  "runs the selected Pi RPC consumer through a pinned native owner over Linux OpenSSH (%s)",
  async (completion) => {
    const fixture = await makeLinuxLoopbackPickerFixture();
    try {
      const cwd = path.join(fixture.home, "pi-proof");
      const executableDir = path.join(fixture.root, "pi-bin");
      await mkdir(cwd, { mode: 0o700 });
      await mkdir(executableDir, { mode: 0o700 });
      const sourceFile = path.join(executableDir, "fixture.c");
      const binaryPath = path.join(executableDir, "pi");
      await writeFile(sourceFile, source, { mode: 0o600 });
      execFileSync("/usr/bin/cc", [sourceFile, "-o", binaryPath], {
        cwd: executableDir,
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        timeout: 10_000,
      });
      await chmod(binaryPath, 0o500);
      const sha256 = createHash("sha256")
        .update(await readFile(binaryPath))
        .digest("hex");
      const binary = await fixture.installOwner(
        fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url)),
      );
      const threadId = ThreadId.makeUnsafe("thread-pi-native");
      const sessionEpoch = 9;
      const targetId = `ssh:${new URLSearchParams({ host: fixture.loopback, user: fixture.user, port: String(fixture.port), transport: "direct-ssh" })}`;
      await storageScope(path.join(fixture.root, "pi-proof.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            binary,
            sql,
            profileBinding: randomBytes(32),
            targetId,
            lockFile: path.join(fixture.root, "owner.lock"),
            sshBinary: fixture.ssh,
            keyscanBinary: fixture.keyscan,
            host: fixture.loopback,
            port: fixture.port,
            user: fixture.user,
            identityFile: fixture.identity,
            knownHostsFile: fixture.knownHosts,
            workspaceRoot: cwd,
            piFixture: { cwd, binaryPath, sha256, threadId, sessionEpoch },
          });
          try {
            const runtime = {
              provider: "pi" as const,
              executionTargetId: targetId,
              threadId,
              sessionEpoch,
              cwd,
              binaryPath,
            };
            const signal = new AbortController().signal;
            await expect(owner.piRpcOwner.probeProvider(runtime, signal)).rejects.toMatchObject({
              code: "trustRequired",
            });
            const trust = await owner.inspectTrust();
            if (trust.state !== "approvalRequired")
              throw new Error("Expected explicit proof trust approval");
            await owner.approveTrust(trust.challenge);
            expect(() =>
              owner.piRpcOwner.startProvider({
                ...runtime,
                sessionFile: path.join(cwd, "unsupported.jsonl"),
              }),
            ).toThrow();
            await expect(
              owner.piRpcOwner.probeProvider({ ...runtime, sessionEpoch: 10 }, signal),
            ).rejects.toMatchObject({ code: "operationDenied" });
            const child = await startOwnedPiRpcProcess({
              owner: owner.piRpcOwner,
              threadId,
              sessionEpoch,
              binaryPath,
              signal,
              providerRuntimeTarget: { location: "remote", executionTargetId: targetId },
              workspaceTarget: { location: "remote", executionTargetId: targetId, cwd },
            });
            expect(child.supportsAgentSettled).toBe(true);
            expect(child.supportsPromptDisposition).toBe(true);
            if (completion === "eof") {
              const stdout = text(child.stdout);
              const stderr = text(child.stderr);
              child.stdin.end('{"id":"fixture","type":"get_state"}\n');
              await expect(stdout).resolves.toBe(
                '{"id":"fixture","type":"response","command":"get_state","success":true}\n',
              );
              await expect(stderr).resolves.toBe("synthetic Pi ready\nsynthetic Pi diagnostic\n");
              await expect(child.exit).resolves.toEqual({ kind: "exited", code: 0 });
            } else {
              const [ready] = await once(child.stderr, "data");
              expect(String(ready)).toContain("synthetic Pi ready");
              child.stdout.resume();
              child.stderr.resume();
              await child.cancel();
              await expect(child.exit).resolves.toMatchObject({
                kind: expect.stringMatching(/^(exited|signaled)$/),
              });
            }
            await owner.disconnect();
            await expect(owner.piRpcOwner.probeProvider(runtime, signal)).rejects.toMatchObject({
              code: "targetDisconnected",
            });
          } finally {
            await owner.close();
          }
        }),
      );
    } finally {
      await fixture.dispose();
    }
  },
  60_000,
);
