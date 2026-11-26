import { ApprovalRequestId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { Effect } from "effect";
import { expect, it } from "vitest";

import {
  readExternalV2Target,
  withProductionV2Owner,
} from "../provider/Layers/OpencodeV2/ServerManager.sshOwner.production.native.fixture.ts";
import { makeProductionAcpTerminalOwner } from "../remote-workspace-bridge/remoteWorkspaceAcpTerminal.owner.production.ts";
import { makeProductionProviderWorkspaceShell } from "../ws/remoteWorkspaceProviderShell.ts";
import type { SshOwnerProductionRegistration } from "./sshOwnerProductionRegistry.ts";
import { makeProductionShellRunner } from "./sshShellRunner.production.ts";

// W2 T-shell live run against a disposable sshd (for example the OrbStack Debian guest),
// with target/debug/bigbud-ssh-owner built on this host. `cwd` is the workspace root; it
// must hold a directory `sub` and a symlink `link` pointing outside the root.
// BIGBUD_TEST_SHELL_EXTERNAL_TARGET='{"host":…,"port":…,"user":…,"identityFile":…,
//   "knownHostsFile":…,"cwd":"/tmp/t-shell/ws","remoteBinary":"/unused"}'
const external = readExternalV2Target(process.env.BIGBUD_TEST_SHELL_EXTERNAL_TARGET);

const thread = (
  runner: ReturnType<typeof makeProductionShellRunner>,
  cwd: string,
  command: string,
  timeoutMs?: number,
) =>
  Effect.runPromise(
    Effect.result(
      runner.run({
        threadId: `t-${Math.random()}`,
        cwd,
        command,
        ...(timeoutMs ? { timeoutMs } : {}),
      }),
    ),
  );

it.skipIf(external === undefined)(
  "runs thread, provider and ACP leases on the production owner with bounds and cancellation",
  async () => {
    await withProductionV2Owner(external!, 1, async ({ handle, targets }) => {
      const { descriptor, cwd: root } = targets[0]!;
      const bound = handle.target(descriptor);
      const trust = await bound.inspectTrust();
      if (trust.state === "approvalRequired") await bound.approveTrust(trust.challenge);
      const live = {
        handle,
        descriptorFor: async () => descriptor,
      } as unknown as SshOwnerProductionRegistration;
      const owner = () => live;
      const runner = makeProductionShellRunner(descriptor.targetId, owner);

      // 1. Thread shell: exact text, cwd, combined output, verbatim exit, no stdin.
      const first = await thread(
        runner,
        `${root}/sub`,
        'printf "%s\\n" "$PWD"; cat; echo err >&2; exit 7',
      );
      expect(first._tag).toBe("Success");
      if (first._tag === "Success")
        expect(first.success).toEqual({ output: `${root}/sub\nerr\n`, exitCode: 7 });

      // 2. Output above one owner chunk is read back completely.
      const big = await thread(runner, root, "head -c 1500000 /dev/zero | tr '\\0' a");
      expect(big._tag === "Success" && big.success.output.length).toBe(1_500_000);

      // 3. A symlink escape is refused by the owner's path walk (recipe exit 3).
      const escape = await thread(runner, `${root}/link`, "pwd");
      expect(escape._tag === "Success" && escape.success.exitCode).toBe(3);

      // 4. Deadline: typed timeout, never replayed.
      const started = Date.now();
      const slow = await thread(runner, root, "sleep 20", 1_000);
      expect(slow._tag).toBe("Failure");
      if (slow._tag === "Failure") expect(slow.failure.message).toContain("timed out");
      expect(Date.now() - started).toBeLessThan(8_000);

      // 5. Provider shell abort kills only this lease, while a thread shell on the
      //    same target completes concurrently (the owner loop is not blocked).
      const provider = makeProductionProviderWorkspaceShell(descriptor.targetId, root, owner);
      const controller = new AbortController();
      const marker = `61.${process.pid % 100_000}`;
      const pending = provider.run(
        {
          workspaceRoot: root,
          cwd: root,
          provider: "thread-tool",
          sessionId: "s",
          invocationId: "i",
          command: `sleep ${marker}`,
          timeoutMs: 120_000,
        },
        controller.signal,
      );
      const quickStart = Date.now();
      const quick = await thread(runner, root, "echo quick");
      expect(quick._tag === "Success" && quick.success.output).toBe("quick\n");
      expect(Date.now() - quickStart).toBeLessThan(5_000);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "shellCancelled" });
      // The remote watchdog reaps the whole command (and the recipe wrapper) once
      // the SSH session is gone: bounded, not instantaneous.
      const aborted = Date.now();
      let remaining = "unknown";
      while (Date.now() - aborted < 6_000) {
        const probe = await thread(runner, root, `pgrep -f '[s]leep ${marker}' | wc -l`);
        remaining = probe._tag === "Success" ? probe.success.output.trim() : "error";
        if (remaining === "0") break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(remaining).toBe("0");
      console.info(`remote teardown after abort: ${Date.now() - aborted} ms`);

      // 6. ACP: the fixed recipe, exact physical cwd, exit 0.
      const acp = makeProductionAcpTerminalOwner({
        targetId: descriptor.targetId,
        workspaceRoot: root,
        owner,
      });
      const lease = await acp.runAcpCommand(
        {
          approval: {
            requestId: ApprovalRequestId.makeUnsafe("r"),
            threadId: ThreadId.makeUnsafe("t"),
            sessionEpoch: 0,
            acpSessionId: "s",
            toolCallId: "c",
          },
          executionTargetId: descriptor.targetId,
          workspaceRoot: root,
          cwd: `${root}/sub`,
          operation: "print-working-directory",
        },
        new AbortController().signal,
      );
      let text = "";
      for await (const chunk of lease.output) text += chunk.toString();
      expect(text).toBe(`${root}/sub\n`);
      expect(await lease.exit).toEqual({ kind: "exited", code: 0 });
    });
  },
  120_000,
);
