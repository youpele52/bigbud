import { realpath, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import { ThreadId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { V2CodingBridge } from "./Coding.bridge.ts";
import { resolveV2FilePython } from "./Coding.files.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { makeV2TargetPreparation } from "./Application.targets.ts";

it("canonical generalized/child requests are approved, target-bound, identity-stable and durably replayed without a second dispatch", async () => {
  await withV2RuntimeFixture(async ({ runtime: fixture, http, directory, events }) => {
    http.autoComplete = false;
    const requests: Record<string, unknown>[] = [];
    const server = createServer(async (request, response) => {
      expect(request.headers["x-bigbud-thread-tool-token"]).toEqual(expect.any(String));
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          result: { threadId: "delegated-child", accepted: true, invocationId: body.invocationId },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture port missing");
    const profile = await realpath(fixture.options.config.profileRoot),
      root = await realpath(directory);
    const coding = await V2CodingBridge.open(profile, await resolveV2FilePython(profile));
    const options = {
      ...fixture.options,
      codingBridge: coding,
      enableLocalTools: true,
      config: { ...fixture.options.config, profileRoot: profile },
    };
    const runtime = new OpencodeV2Runtime({
      ...options,
      prepareSession: makeV2TargetPreparation(options, profile, undefined, address.port),
    });
    const threadId = ThreadId.makeUnsafe("canonical-execution"),
      modelSelection = {
        provider: "opencodeV2",
        subProviderID: "synthetic-provider",
        model: "synthetic-model",
      } as const;
    try {
      await runtime.start({
        threadId,
        cwd: root,
        modelSelection,
        runtimeMode: "approval-required",
      });
      await runtime.send({
        threadId,
        modelSelection,
        input: "canonical tools",
        requestMessageId: MessageId.makeUnsafe("canonical-tools"),
      });
      const owner = runtime.get(threadId);
      const call = {
        action: "orchestration",
        input: {
          path: ".",
          request: {
            action: "create_thread",
            title: "Child",
            task: "Implement separate task",
            watchForCompletion: true,
            invocationId: "MODEL-CONTROLLED",
            sourceMessageId: "MODEL-CONTROLLED",
          },
        },
        sessionID: owner.native.id,
        messageID: "assistant-owner",
        callID: "child-1",
      };
      const invoke = coding.invoke(call);
      await expect
        .poll(() => events.find((event) => event.type === "request.opened"))
        .toBeDefined();
      expect(requests).toHaveLength(0);
      const approval = events.find((event) => event.type === "request.opened")!;
      if (approval.type !== "request.opened") throw new Error("approval missing");
      expect(approval.payload.args).toMatchObject({
        path: root,
        executionIntent: { action: "orchestration", request: { action: "create_thread" } },
      });
      await runtime.respondPermission(threadId, approval.requestId!, "accept");
      expect(JSON.stringify(await invoke)).toContain("delegated-child");
      expect(requests[0]!.invocationId).toMatch(/^v2-tool:/);
      expect(requests[0]!.sourceMessageId).toMatch(/^mcp-source:/);
      await coding.invoke(call);
      expect(requests).toHaveLength(1);
      await expect(
        coding.invoke({
          ...call,
          input: { path: ".", request: { action: "create_thread", title: "Changed" } },
        }),
      ).rejects.toThrow("changed");
      if (process.platform === "darwin") {
        const offset = events.length;
        const shell = coding.invoke({
          ...call,
          action: "shell",
          callID: "shell-1",
          input: { path: ".", command: "printf 'native-approved' > shell-result.txt" },
        });
        await expect
          .poll(() => events.slice(offset).find((event) => event.type === "request.opened"))
          .toBeDefined();
        const request = events.slice(offset).find((event) => event.type === "request.opened")!;
        await runtime.respondPermission(threadId, request.requestId!, "accept");
        expect(JSON.parse((await shell).content!).exitCode).toBe(0);
        expect(await readFile(path.join(root, "shell-result.txt"), "utf8")).toBe("native-approved");
        const childId = ThreadId.makeUnsafe("delegated-child");
        await runtime.start({
          threadId: childId,
          cwd: root,
          modelSelection,
          runtimeMode: "approval-required",
        });
        await runtime.send({
          threadId: childId,
          modelSelection,
          input: "independent delegated work",
          requestMessageId: MessageId.makeUnsafe("durable-child-message"),
        });
        const child = runtime.get(childId);
        expect(child.native.id).not.toBe(owner.native.id);
        expect(child.lease.generation).toBe(owner.lease.generation);
        expect(child.resources!.orchestration!.threadId).toBe(childId);
        expect(child.resources!.orchestration!.token).not.toBe(
          owner.resources!.orchestration!.token,
        );
        await runtime.stop(threadId);
        expect(runtime.get(childId)).toBe(child);
        const childOffset = events.length;
        const childShell = coding.invoke({
          ...call,
          action: "shell",
          sessionID: child.native.id,
          callID: "shell-1",
          input: { path: ".", command: "printf 'child-owned' > child-result.txt" },
        });
        await expect
          .poll(() =>
            events
              .slice(childOffset)
              .find((event) => event.type === "request.opened" && event.threadId === childId),
          )
          .toBeDefined();
        const childRequest = events
          .slice(childOffset)
          .find((event) => event.type === "request.opened" && event.threadId === childId)!;
        await runtime.respondPermission(childId, childRequest.requestId!, "accept");
        expect(JSON.parse((await childShell).content!).exitCode).toBe(0);
        expect(await readFile(path.join(root, "child-result.txt"), "utf8")).toBe("child-owned");
      }
    } finally {
      coding.close();
      await runtime.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
