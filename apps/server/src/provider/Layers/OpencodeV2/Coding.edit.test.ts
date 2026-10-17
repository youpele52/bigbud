import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { ThreadId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { V2CodingBridge } from "./Coding.bridge.ts";
import { resolveV2FilePython } from "./Coding.files.ts";

it("edit approves and writes replacement metacharacters literally, not String.replace substitution syntax", async () => {
  await withV2RuntimeFixture(async ({ runtime: fixture, http, directory, events }) => {
    const profile = fixture.options.config.profileRoot;
    const coding = await V2CodingBridge.open(profile, await resolveV2FilePython(profile));
    const runtime = new OpencodeV2Runtime({
      ...fixture.options,
      codingBridge: coding,
      enableLocalTools: true,
    });
    http.autoComplete = false;
    const threadId = ThreadId.makeUnsafe("coding-literal-edit");
    const modelSelection = {
      provider: "opencodeV2",
      subProviderID: "synthetic-provider",
      model: "synthetic-model",
    } as const;
    try {
      await runtime.start({
        threadId,
        cwd: directory,
        modelSelection,
        runtimeMode: "approval-required",
      });
      await runtime.send({
        threadId,
        modelSelection,
        requestMessageId: MessageId.makeUnsafe("literal-edit"),
        input: "synthetic",
      });
      for (const [index, newText] of ["$&", "$$", "$`", "$'"].entries()) {
        const filename = `literal-${index}.txt`;
        await writeFile(path.join(directory, filename), "before TARGET after");
        const offset = events.length;
        const invocation = coding.invoke({
          action: "edit",
          input: { path: filename, oldText: "TARGET", newText },
          sessionID: runtime.get(threadId).native.id,
          messageID: "assistant",
          callID: `literal-${index}`,
        });
        await expect
          .poll(() => events.slice(offset).find((event) => event.type === "request.opened"))
          .toBeDefined();
        const request = events.slice(offset).find((event) => event.type === "request.opened")!;
        expect(request.type).toBe("request.opened");
        if (request.type !== "request.opened") throw new Error("approval missing");
        expect(request.payload.args).toMatchObject({ proposedContent: `before ${newText} after` });
        expect(await readFile(path.join(directory, filename), "utf8")).toBe("before TARGET after");
        await runtime.respondPermission(threadId, request.requestId!, "accept");
        await invocation;
        expect(await readFile(path.join(directory, filename), "utf8")).toBe(
          `before ${newText} after`,
        );
      }
    } finally {
      coding.close();
      await runtime.close();
    }
  });
});
