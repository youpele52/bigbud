import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import { startRemoteCodexAppServerProcessAsync } from "../codex/codexAppServerManager.process.remote.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import { storageScope } from "./sshOwnerPickerProof.integration.ts";
import { makeLinuxLoopbackPickerFixture } from "./sshPicker.loopback.fixture.linux.ts";

const live = process.platform === "linux" && process.env.BIGBUD_TEST_SSH_OWNER_PICKER_PROOF === "1";
type Fixture = Awaited<ReturnType<typeof makeLinuxLoopbackPickerFixture>>;

// A fixed protocol recorder, not the real Codex CLI or a provider account.
const source = String.raw`
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  if (strcmp(argv[1], "--version") == 0) {
    puts("codex-cli 0.166.0");
    return 0;
  }
  if (strcmp(argv[1], "app-server") != 0 || getenv("SSH_AUTH_SOCK")) return 3;
  char cwd[4096], request[4096];
  const char *home = getenv("HOME");
  if (!home || !getcwd(cwd, sizeof cwd) || strcmp(home, cwd) != 0) return 4;
  fputs("synthetic app-server ready\n", stderr);
  fflush(stderr);
  if (!fgets(request, sizeof request, stdin) || !strstr(request, "initialize")) return 5;
  puts("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"fixture\":true}}");
  fputs("synthetic app-server diagnostic\n", stderr);
  return 0;
}
`;

async function stageCodex(fixture: Fixture) {
  const cwd = path.join(fixture.home, "codex-proof");
  const bin = path.join(fixture.root, "codex-bin");
  await mkdir(cwd, { mode: 0o700 });
  await mkdir(bin, { mode: 0o700 });
  const sourceFile = path.join(bin, "fixture.c");
  const binaryPath = path.join(bin, "codex");
  await writeFile(sourceFile, source, { mode: 0o600 });
  execFileSync("/usr/bin/cc", [sourceFile, "-o", binaryPath], {
    cwd: bin,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    timeout: 10_000,
  });
  await chmod(binaryPath, 0o500);
  return {
    cwd,
    binaryPath,
    sha256: createHash("sha256")
      .update(await readFile(binaryPath))
      .digest("hex"),
  };
}

async function withProofAgent<A>(
  fixture: Fixture,
  run: (agentPath: string, identityFile: string) => Promise<A>,
) {
  const dir = path.join(fixture.root, "private-agent");
  await mkdir(dir, { mode: 0o700 });
  const agentPath = path.join(dir, "agent.sock");
  const agent = spawn("/usr/bin/ssh-agent", ["-D", "-a", agentPath], {
    cwd: dir,
    env: { HOME: fixture.home, PATH: "/usr/bin:/bin", LC_ALL: "C" },
    stdio: "ignore",
  });
  const closed = new Promise<void>((resolve) => agent.once("close", resolve));
  agent.on("error", () => {});
  try {
    await vi.waitFor(async () => expect((await lstat(agentPath)).isSocket()).toBe(true));
    await chmod(agentPath, 0o600);
    execFileSync("/usr/bin/ssh-add", [fixture.identity], {
      cwd: dir,
      env: { SSH_AUTH_SOCK: agentPath, HOME: fixture.home, PATH: "/usr/bin:/bin", LC_ALL: "C" },
      timeout: 5_000,
      stdio: "ignore",
    });
    const identityFile = path.join(fixture.root, "selected-public-identity");
    await writeFile(identityFile, await readFile(`${fixture.identity}.pub`), { mode: 0o600 });
    await unlink(fixture.identity); // Only the isolated agent still holds the synthetic private key.
    return await run(agentPath, identityFile);
  } finally {
    agent.kill();
    await closed;
  }
}

it.skipIf(!live).each(["eof", "cancel", "stale"] as const)(
  "runs a pinned Codex fixture through the selected native launch and exact POSIX agent (%s)",
  async (completion) => {
    const fixture = await makeLinuxLoopbackPickerFixture();
    try {
      const staged = await stageCodex(fixture);
      const binary = await fixture.installOwner(
        fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url)),
      );
      await withProofAgent(fixture, (identityAgentPath, identityFile) =>
        storageScope(path.join(fixture.root, "codex-proof.sqlite"), (sql) =>
          Effect.promise(async () => {
            const threadId = ThreadId.makeUnsafe("thread-codex-native");
            const sessionEpoch = 7;
            const targetId = `ssh:${new URLSearchParams({ host: fixture.loopback, user: fixture.user, port: String(fixture.port), transport: "direct-ssh" })}`;
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
              identityFile,
              identityAgentPath,
              knownHostsFile: fixture.knownHosts,
              workspaceRoot: staged.cwd,
              codexFixture: { ...staged, threadId, sessionEpoch },
            });
            try {
              const runtime = {
                provider: "codex" as const,
                executionTargetId: targetId,
                threadId,
                sessionEpoch,
                cwd: staged.cwd,
                binaryPath: staged.binaryPath,
              };
              const signal = new AbortController().signal;
              await expect(owner.probeProvider(runtime, signal)).rejects.toMatchObject({
                code: "trustRequired",
              });
              const trust = await owner.inspectTrust();
              if (trust.state !== "approvalRequired") throw new Error("Expected explicit approval");
              await owner.approveTrust(trust.challenge);
              await expect(
                owner.probeProvider({ ...runtime, sessionEpoch: 8 }, signal),
              ).rejects.toMatchObject({ code: "operationDenied" });
              expect(() =>
                owner.startProvider({ ...runtime, enableDefaultModeUserInput: true }),
              ).toThrow();
              const cancelled = owner.startProvider({
                ...runtime,
                enableDefaultModeUserInput: false,
              });
              await cancelled.cancel();
              await expect(cancelled.ready).rejects.toThrow("cancelled");

              if (completion === "stale") {
                await expect(owner.probeProvider(runtime, signal)).resolves.toMatchObject({
                  status: 0,
                });
                await owner.connect();
                const stale = owner.startProvider({
                  ...runtime,
                  enableDefaultModeUserInput: false,
                });
                await expect(stale.ready).rejects.toMatchObject({ code: "operationDenied" });
                return;
              }

              const child = await startRemoteCodexAppServerProcessAsync(
                { ...runtime, runtimeMode: "full-access" },
                signal,
                { owner },
              );
              expect(child.version).toBe("0.166.0");
              if (completion === "eof") {
                const stdout = text(child.stdout);
                const stderr = text(child.stderr);
                child.stdin.end('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
                await expect(stdout).resolves.toBe(
                  '{"jsonrpc":"2.0","id":1,"result":{"fixture":true}}\n',
                );
                await expect(stderr).resolves.toBe(
                  "synthetic app-server ready\nsynthetic app-server diagnostic\n",
                );
                await expect(child.exit).resolves.toEqual({ kind: "exited", code: 0 });
              } else {
                const [ready] = await once(child.stderr, "data");
                expect(String(ready)).toContain("synthetic app-server ready");
                child.stdout.resume();
                child.stderr.resume();
                await child.cancel();
                await expect(child.exit).resolves.toMatchObject({
                  kind: expect.stringMatching(/^(exited|signaled)$/),
                });
              }
              await unlink(identityAgentPath);
              await expect(
                owner.listRemoteFolders({ executionTargetId: targetId }),
              ).rejects.toMatchObject({ code: "configUnsupported" });
              await owner.disconnect();
              await expect(owner.probeProvider(runtime, signal)).rejects.toMatchObject({
                code: "targetDisconnected",
              });
            } finally {
              await owner.close();
            }
          }),
        ),
      );
    } finally {
      await fixture.dispose();
    }
  },
  60_000,
);
