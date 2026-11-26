import { expect, it } from "vitest";

import {
  readExternalV2Target,
  withProductionV2Owner,
} from "../provider/Layers/OpencodeV2/ServerManager.sshOwner.production.native.fixture.ts";
import type { PickerProofBoundTarget } from "./sshOwnerPickerProof.client.session.types.ts";

// W2 T-term / U16 live proof: a real target-free `bigbud-ssh-owner --production`
// against an already-running disposable sshd (PermitTTY yes). Same target JSON
// shape as the OpenCode production test:
// BIGBUD_TEST_SSH_OWNER_PRODUCTION_TERMINAL_TARGET='{"host":…,"port":…,"user":…,
//   "identityFile":…,"knownHostsFile":…,"cwd":…,"remoteBinary":"/unused"}'
const external = readExternalV2Target(process.env.BIGBUD_TEST_SSH_OWNER_PRODUCTION_TERMINAL_TARGET);
const enabled =
  external !== undefined && (process.platform === "darwin" || process.platform === "linux");
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

async function until<A>(read: () => Promise<A>, done: (value: A) => boolean, label: string) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function openShell(bound: PickerProofBoundTarget, cwd: string, shell?: string) {
  const reservation = await bound.prepareProofTerminal({
    cwd,
    threadId: "thread",
    terminalId: "pane",
    cols: 100,
    rows: 30,
    ...(shell ? { shell } : {}),
  });
  return {
    lease: reservation.lease,
    opened: await bound.openReservedProofTerminal(reservation.lease),
  };
}

it.skipIf(!enabled)(
  "opens a production login PTY, inspects its exact shell tree and launches a U16 shell",
  async () => {
    await withProductionV2Owner(
      external!,
      1,
      async ({ handle, targets }) => {
        const { descriptor, cwd } = targets[0]!;
        const bound = handle.target(descriptor);
        const trust = await bound.inspectTrust();
        if (trust.state === "approvalRequired") await bound.approveTrust(trust.challenge);
        // Folder listing opens the target's verified master, which inspection reuses.
        await bound.listRemoteFolders({ executionTargetId: descriptor.targetId, path: cwd });

        const shells = await bound.listTerminalShells();
        expect(shells).toEqual(expect.arrayContaining(["/bin/sh", "/bin/bash"]));
        expect(shells.every((shell) => shell.startsWith("/"))).toBe(true);

        // Default: the account's login shell, then a foreground child in its tree.
        const first = await openShell(bound, cwd);
        expect(first.opened.live).toBe(true);
        await bound.writeProofTerminalInput(first.lease, 1, Buffer.from("sleep 41\n"));
        const busy = await until(
          () => bound.inspectTerminal(first.lease),
          (snapshot) => snapshot.processes.some((process) => /sleep 41/.test(process.command)),
          "sleep in the shell tree",
        );
        expect(busy.processes[0]!.pid).toBe(busy.shellPid);
        const sleeper = busy.processes.find((process) => /sleep 41/.test(process.command))!;
        expect(sleeper.parentPid).toBe(busy.shellPid);
        expect(busy.processes.every((process) => !/sshd/.test(process.command))).toBe(true);
        expect((await bound.closeProofTerminal(first.lease)).live).toBe(false);

        // U16: a listed shell launches; an unlisted executable is a typed refusal.
        const bash = await openShell(bound, cwd, "/bin/bash");
        await bound.writeProofTerminalInput(bash.lease, 1, Buffer.from("echo shell=$0\n"));
        await until(
          () => bound.proofTerminalStatus(bash.lease),
          (status) => /shell=-?(\/bin\/)?bash/.test(text(status.sample)),
          "bash login shell",
        );
        const bashTree = await bound.inspectTerminal(bash.lease);
        expect(bashTree.processes[0]!.command).toMatch(/bash/);
        expect((await bound.closeProofTerminal(bash.lease)).live).toBe(false);
        await expect(openShell(bound, cwd, "/usr/bin/env")).rejects.toMatchObject({
          code: "terminalShellUnavailable",
        });
      },
      { binding: {} },
    );
  },
  120_000,
);
