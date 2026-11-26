import { expect, it } from "vitest";

import {
  readExternalV2Target,
  withProductionV2Owner,
} from "../provider/Layers/OpencodeV2/ServerManager.sshOwner.production.native.fixture.ts";
import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import { makeProductionTypedSshToolCapability } from "../tool-transport/toolTransport.ssh.owner.production.ts";
import { runOwnedRemoteWorkspaceTool } from "./http.threadTools.remoteWorkspaceTool.ts";
import { makeProductionProviderWorkspaceShell } from "./remoteWorkspaceProviderShell.ts";

// Typed bridge tools and the bash envelope on a production owner against a disposable sshd.
// `cwd` is an empty, writable workspace root on the target.
// BIGBUD_TEST_TOOLS_EXTERNAL_TARGET='{"host":…,"port":…,"user":…,"identityFile":…,
//   "knownHostsFile":…,"cwd":"/tmp/t-tools/ws","remoteBinary":"/unused"}'
// BIGBUD_TEST_TOOLS_EXPECT_RG=1 when ripgrep is installed on the target.
const external = readExternalV2Target(process.env.BIGBUD_TEST_TOOLS_EXTERNAL_TARGET);

it.skipIf(external === undefined)(
  "runs read, write, list, patch and search as typed owner verbs and bash as provider shell text",
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
      const capability = makeProductionTypedSshToolCapability(
        descriptor.targetId,
        root,
        () => live,
      );
      const run = (tool: Parameters<typeof runOwnedRemoteWorkspaceTool>[1]) =>
        runOwnedRemoteWorkspaceTool(capability, tool);

      await run({ tool: "write_text", path: "src/deep/a.txt", content: "one\ntwo\nthree\n" });
      expect(await run({ tool: "read_text", path: `${root}/src/deep/a.txt` })).toEqual({
        tool: "read_text",
        content: "one\ntwo\nthree\n",
      });
      expect(await run({ tool: "list_dir", path: "src" })).toMatchObject({
        entries: [{ name: "deep", directory: true }],
      });
      const patch = [
        "--- a/src/deep/a.txt",
        "+++ b/src/deep/a.txt",
        "@@ -1,3 +1,3 @@",
        " one",
        "-two",
        "+TWO",
        " three",
        "--- /dev/null",
        "+++ b/src/new.txt",
        "@@ -0,0 +1 @@",
        "+fresh",
        "",
      ].join("\n");
      await run({ tool: "apply_patch", patch });
      expect(await run({ tool: "read_text", path: "src/deep/a.txt" })).toMatchObject({
        content: "one\nTWO\nthree\n",
      });
      expect(await run({ tool: "read_text", path: "src/new.txt" })).toMatchObject({
        content: "fresh\n",
      });
      // Typed glob over the owner's workspace index.
      const index = (indexSignal?: AbortSignal) =>
        bound.indexProofWorkspace({ executionTargetId: descriptor.targetId, workspaceRoot: root });
      expect(
        await runOwnedRemoteWorkspaceTool(
          capability,
          { tool: "glob", pattern: "*.txt", path: "src", limit: 10 },
          undefined,
          index,
        ),
      ).toMatchObject({ paths: ["deep/a.txt", "new.txt"] });
      await expect(run({ tool: "read_text", path: "../outside" })).rejects.toThrow(
        /outside the workspace/,
      );
      const search = run({ tool: "search", pattern: "TWO", path: "src", limit: 10 });
      if (process.env.BIGBUD_TEST_TOOLS_EXPECT_RG === "1")
        expect(await search).toMatchObject({ matches: [{ path: "src/deep/a.txt", line: 2 }] });
      else await expect(search).rejects.toMatchObject({ code: "proofRipgrepUnavailable" });

      // Decision A: the bridge's bash envelope runs as provider shell command text.
      const shell = makeProductionProviderWorkspaceShell(descriptor.targetId, root, () => live);
      const bash = await shell.run({
        workspaceRoot: root,
        cwd: root,
        provider: "thread-tool",
        sessionId: "s",
        invocationId: "i",
        command: "cat src/new.txt && ls src",
        timeoutMs: 30_000,
      });
      expect(bash).toMatchObject({ output: "fresh\ndeep\nnew.txt\n", exitCode: 0 });
    });
  },
  120_000,
);
