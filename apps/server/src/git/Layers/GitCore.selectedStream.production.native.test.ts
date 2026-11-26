import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  readExternalV2Target,
  withProductionV2Owner,
} from "../../provider/Layers/OpencodeV2/ServerManager.sshOwner.production.native.fixture.ts";
import type { SshOwnerProductionRegistration } from "../../ssh/sshOwnerProductionRegistry.ts";
import { isInitiatingTransportUnavailable } from "./GitCore.initiatingTransport.ts";
import { makeProductionInitiatingFetchBinding } from "./GitCore.selectedStream.production.ts";
import { openProductionUploadLease } from "./GitCore.selectedStream.production.ts";

// U15 live run against a disposable sshd (for example the OrbStack Debian guest), with
// target/debug/bigbud-ssh-owner built on this host. The target `cwd` is the workspace root;
// it must hold `repo.git` (main at BIGBUD_TEST_U15_EXPECTED_HEAD) and `link.git`, a symlink
// to a repository outside the root. `outsidePath` names that outside repository.
// BIGBUD_TEST_U15_EXTERNAL_TARGET='{"host":…,"port":…,"user":…,"identityFile":…,
//   "knownHostsFile":…,"cwd":"/tmp/u15/ws","remoteBinary":"/unused","outsidePath":…}'
const raw = process.env.BIGBUD_TEST_U15_EXTERNAL_TARGET;
const external = readExternalV2Target(raw);
const outsidePath =
  raw === undefined ? "" : (JSON.parse(raw) as { outsidePath: string }).outsidePath;
const expectedHead = process.env.BIGBUD_TEST_U15_EXPECTED_HEAD ?? "";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

it.skipIf(external === undefined)(
  "fetches through the production owner inside a workspace root and refuses outside it",
  async () => {
    await withProductionV2Owner(external!, 1, async ({ handle, targets }) => {
      const { descriptor, cwd: workspaceRoot } = targets[0]!;
      const bound = handle.target(descriptor);
      const trust = await bound.inspectTrust();
      if (trust.state === "approvalRequired") await bound.approveTrust(trust.challenge);
      const registration = {
        handle,
        descriptorFor: async () => descriptor,
      } as unknown as SshOwnerProductionRegistration;
      const records = async () => [{ executionTargetId: descriptor.targetId, workspaceRoot }];
      const binding = makeProductionInitiatingFetchBinding({ owner: () => registration, records });
      const local = mkdtempSync(join(tmpdir(), "bbu15-"));
      try {
        git(local, "init", "-q", "-b", "main");
        const url = (repo: string) =>
          `ssh://${descriptor.user}@${descriptor.host}:${descriptor.port}${repo}`;
        git(local, "remote", "add", "origin", url(`${workspaceRoot}/repo.git`));
        const operands = { cwd: local, remoteName: "origin", refspecs: [], timeoutMs: 30_000 };
        // 1. Inside the root: the tracking ref advances to the target's head.
        await expect(binding.fetch(operands, new AbortController().signal)).resolves.toBe(
          "fetched",
        );
        expect(git(local, "rev-parse", "origin/main")).toBe(expectedHead);
        // 2. Outside every root: refused before the owner is asked.
        git(local, "remote", "set-url", "origin", url(outsidePath));
        const outside = await binding
          .fetch(operands, new AbortController().signal)
          .catch((cause: unknown) => cause);
        expect(isInitiatingTransportUnavailable(outside)).toBe(true);
        // 3. The owner itself refuses an outside path with no process started.
        await expect(
          bound.openGitUpload(new Uint8Array(32).fill(1), workspaceRoot, outsidePath),
        ).rejects.toMatchObject({ code: "invalidOperands" });
        // 4. A symlink inside the root that escapes it: the target guard refuses.
        const lease = await openProductionUploadLease(
          bound,
          workspaceRoot,
          `${workspaceRoot}/link.git`,
          new AbortController().signal,
        );
        lease.pipes.stdout.resume();
        lease.pipes.stdin.end();
        const settled = (await lease.exit) as { code?: string; phase?: string };
        expect(settled).toMatchObject({ code: "operationDenied" });
        await lease.close({ mode: "terminate", timeoutMs: 2_000 });
      } finally {
        rmSync(local, { recursive: true, force: true });
      }
    });
  },
  120_000,
);
