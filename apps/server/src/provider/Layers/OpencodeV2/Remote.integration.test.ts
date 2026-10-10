import { mkdir, realpath, readFile, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { V2CodingBridge } from "./Coding.bridge.ts";
import { resolveV2FilePython } from "./Coding.files.ts";
import { makeV2TargetPreparation } from "./Application.targets.ts";
import { makeV2RemoteAgentFixture } from "./Remote.fixture.ts";
import { V2RemoteFiles } from "./Remote.files.ts";

it("target composition injects remote coding and prepared attachment context without exposing native local tools", async () => {
  await withV2RuntimeFixture(async ({ runtime: fixture, http, directory, events }) => {
    http.autoComplete = false;
    const profile = await realpath(fixture.options.config.profileRoot);
    const remoteRoot = await realpath(directory);
    await writeFile(path.join(remoteRoot, "code.txt"), "original TARGET tail");
    await writeFile(path.join(remoteRoot, "media.txt"), "remote media");
    await symlink(profile, path.join(remoteRoot, "escape"));
    const agent = await makeV2RemoteAgentFixture(remoteRoot, profile);
    const coding = await V2CodingBridge.open(profile, await resolveV2FilePython(profile));
    const options = {
      ...fixture.options,
      config: { ...fixture.options.config, profileRoot: profile },
      codingBridge: coding,
      enableLocalTools: true,
    };
    const runtime = new OpencodeV2Runtime({
      ...options,
      prepareSession: makeV2TargetPreparation(options, profile, async () => agent.client),
    });
    const target = "ssh:host=synthetic.invalid&user=fixture&auth=ssh-key&transport=agent";
    const threadId = ThreadId.makeUnsafe("remote-composed"),
      modelSelection = {
        provider: "opencodeV2",
        subProviderID: "synthetic-provider",
        model: "synthetic-model",
      } as const;
    try {
      await runtime.start({
        threadId,
        cwd: remoteRoot,
        providerRuntimeExecutionTargetId: "local",
        workspaceExecutionTargetId: target,
        modelSelection,
        runtimeMode: "approval-required",
      });
      const owner = runtime.get(threadId);
      expect(owner.native.location.directory).not.toBe(remoteRoot);
      expect(owner.native.permissions).toEqual(
        expect.arrayContaining([{ action: "*", resource: "*", effect: "deny" }]),
      );
      expect(
        owner.native.permissions?.some(
          (rule) =>
            ["read", "shell", "edit", "skill"].includes(rule.action) && rule.effect !== "deny",
        ),
      ).toBe(false);
      await runtime.send({
        threadId,
        modelSelection,
        requestMessageId: MessageId.makeUnsafe("remote-with-media"),
        input: "remote edit",
        attachments: [
          {
            type: "path",
            id: "remote-media",
            path: path.join(remoteRoot, "media.txt"),
            entryKind: "file",
            name: "media.txt",
            mimeType: "text/plain",
            sizeBytes: 0,
          },
        ],
      });
      const prompt = http.calls.find((call) => call.pathname.endsWith("/prompt"))!;
      expect(prompt.body.files).toEqual([]);
      expect(prompt.body.text).toContain("remote media");
      expect(prompt.body.text).toContain(target);
      const invocation = coding.invoke({
        action: "edit",
        input: { path: "code.txt", oldText: "TARGET", newText: "$& remote" },
        sessionID: owner.native.id,
        messageID: "assistant",
        callID: "remote-edit",
      });
      await expect
        .poll(() => events.find((event) => event.type === "request.opened"))
        .toBeDefined();
      const request = events.find((event) => event.type === "request.opened")!;
      if (request.type !== "request.opened") throw new Error("approval missing");
      expect(request.payload.args).toMatchObject({
        path: path.join(remoteRoot, "code.txt"),
        executionTargetId: target,
        proposedContent: "original $& remote tail",
      });
      await runtime.respondPermission(threadId, request.requestId!, "accept");
      await invocation;
      expect(await readFile(path.join(remoteRoot, "code.txt"), "utf8")).toBe(
        "original $& remote tail",
      );
      expect(agent.requests.some((frame) => frame.type === "writeFileRequest")).toBe(true);
      await mkdir(path.join(remoteRoot, "src"));
      await writeFile(path.join(remoteRoot, "src", "child.txt"), "child");
      const offset = events.length;
      const listCall = {
        action: "list",
        input: { path: "src" },
        sessionID: owner.native.id,
        messageID: "assistant-list",
        callID: "remote-list-src",
      };
      const listing = coding.invoke(listCall);
      await expect
        .poll(() => events.slice(offset).find((event) => event.type === "request.opened"))
        .toBeDefined();
      const listApproval = events.slice(offset).find((event) => event.type === "request.opened")!;
      if (listApproval.type !== "request.opened") throw new Error("list approval missing");
      expect(listApproval.payload.args).toMatchObject({
        path: path.join(remoteRoot, "src"),
        executionTargetId: target,
        action: "list",
      });
      await runtime.respondPermission(threadId, listApproval.requestId!, "accept");
      expect(JSON.stringify(await listing)).toContain("child.txt");
      const requestsAfterList = agent.requests.length;
      expect(JSON.stringify(await coding.invoke(listCall))).toContain("child.txt");
      expect(agent.requests).toHaveLength(requestsAfterList);
      for (const blocked of [".bigbud", "escape", "../outside"]) {
        await expect(
          coding.invoke({
            ...listCall,
            input: { path: blocked },
            callID: `blocked-list-${blocked}`,
          }),
        ).rejects.toThrow();
      }
      await expect(
        owner.resources!.codingFiles!.run({
          action: "read",
          path: "escape/.bigbud-opencode-v2-development",
        }),
      ).rejects.toThrow();
      await expect(
        owner.resources!.codingFiles!.run({
          action: "write",
          path: ".opencode/plugin.js",
          content: "wrong",
          expectedSha256: agent.sha("old"),
        }),
      ).rejects.toThrow("protected");
      const cursor = owner.session.resumeCursor,
        synthetic = owner.native.location.directory;
      await runtime.stop(threadId);
      await expect(
        owner.resources!.codingFiles!.run({ action: "read", path: "code.txt" }),
      ).rejects.toThrow("generation lost");
      http.running = true; // Disposable process replacement retains the fixture's native history.
      await runtime.start({
        threadId,
        cwd: remoteRoot,
        providerRuntimeExecutionTargetId: "local",
        workspaceExecutionTargetId: target,
        modelSelection,
        runtimeMode: "approval-required",
        resumeCursor: cursor,
      });
      expect(runtime.get(threadId).native.location.directory).toBe(synthetic);
    } finally {
      coding.close();
      await runtime.close();
    }
  });
});

it("remote workspace client generation cannot rebind writes; absent-file CAS and path escapes are truthful unsupported", async () => {
  await withV2RuntimeFixture(async ({ runtime, directory }) => {
    const profile = await realpath(runtime.options.config.profileRoot),
      root = await realpath(directory);
    await mkdir(path.join(root, "sub"));
    const agent = await makeV2RemoteAgentFixture(root, profile);
    let client = agent.client;
    const files = await V2RemoteFiles.open("ssh:synthetic", root, "generation", async () => client);
    await expect(
      files.run({ action: "write", path: "new.txt", content: "wrong", expectedSha256: null }),
    ).rejects.toThrow("absent-file CAS");
    await expect(files.run({ action: "read", path: "../secret" })).rejects.toThrow("escapes");
    client = (await makeV2RemoteAgentFixture(root, profile)).client;
    await expect(
      files.run({
        action: "edit",
        path: "old.txt",
        content: "wrong",
        expectedSha256: agent.sha("old"),
      }),
    ).rejects.toThrow("generation lost");
    expect(agent.requests.some((frame) => frame.type === "writeFileRequest")).toBe(false);
  });
});

it("native generation loss revokes its remote target and cleans bridge metadata without deleting replay location", async () => {
  await withV2RuntimeFixture(async ({ runtime: fixture, http, directory }) => {
    const profile = await realpath(fixture.options.config.profileRoot),
      root = await realpath(directory);
    const agent = await makeV2RemoteAgentFixture(root, profile);
    const runtime = new OpencodeV2Runtime({
      ...fixture.options,
      prepareSession: makeV2TargetPreparation(fixture.options, profile, async () => agent.client),
    });
    const threadId = ThreadId.makeUnsafe("remote-native-loss");
    try {
      await runtime.start({
        threadId,
        cwd: root,
        providerRuntimeExecutionTargetId: "local",
        workspaceExecutionTargetId: "ssh:synthetic",
        modelSelection: {
          provider: "opencodeV2",
          subProviderID: "synthetic-provider",
          model: "synthetic-model",
        },
        runtimeMode: "approval-required",
      });
      const owner = runtime.get(threadId);
      const metadata = path.join(owner.native.location.directory, ".bigbud");
      expect(await realpath(metadata)).toBe(metadata);
      http.die();
      await expect
        .poll(() =>
          realpath(metadata).then(
            () => false,
            () => true,
          ),
        )
        .toBe(true);
      await expect(
        owner.resources!.codingFiles!.run({ action: "list", path: "." }),
      ).rejects.toThrow("generation lost");
      expect(await realpath(owner.native.location.directory)).toBe(owner.native.location.directory);
    } finally {
      await runtime.close();
    }
  });
});
