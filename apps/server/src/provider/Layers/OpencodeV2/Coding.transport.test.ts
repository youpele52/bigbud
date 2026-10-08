import { request as httpRequest } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { ThreadId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { makeV2CodingTransport } from "./Coding.transport.ts";

/** Separate flushed HTTP chunks put UTF-8 codepoints across real server iteration boundaries. */
async function postChunks(url: string, token: string, chunks: readonly Buffer[]) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode!, body }));
      },
    );
    request.on("error", reject);
    void (async () => {
      request.flushHeaders();
      for (const chunk of chunks) {
        await new Promise<void>((done, fail) =>
          request.write(chunk, (error) => (error ? fail(error) : done())),
        );
        await new Promise<void>((done) => setTimeout(done, 20));
      }
      request.end();
    })().catch(reject);
  });
}

it("transport preserves split UTF-8 path/content through canonical approval and disk write, rejects malformed UTF-8 and limits raw bytes", async () => {
  await withV2RuntimeFixture(async ({ runtime: fixture, http, directory, events }) => {
    const transport = await makeV2CodingTransport(
      await realpath(fixture.options.config.profileRoot),
    );
    const runtime = new OpencodeV2Runtime({
      ...fixture.options,
      codingBridge: transport.bridge,
      enableLocalTools: true,
    });
    http.autoComplete = false;
    try {
      const source = await readFile(transport.pluginPath, "utf8");
      const { url, token } = JSON.parse(
        source.split("\n")[0]!.slice("// bigbud-coding-owned-v1 ".length),
      ) as { url: string; token: string };
      const threadId = ThreadId.makeUnsafe("coding-utf8");
      const modelSelection = {
        provider: "opencodeV2",
        subProviderID: "synthetic-provider",
        model: "synthetic-model",
      } as const;
      await runtime.start({
        threadId,
        cwd: directory,
        modelSelection,
        runtimeMode: "approval-required",
      });
      await runtime.send({
        threadId,
        modelSelection,
        requestMessageId: MessageId.makeUnsafe("coding-utf8"),
        input: "synthetic",
      });
      const filename = "café.txt",
        content = "é café 🌱\n";
      const bytes = Buffer.from(
        JSON.stringify({
          action: "write",
          input: { path: filename, content },
          sessionID: runtime.get(threadId).native.id,
          messageID: "assistant",
          callID: "utf8",
        }),
      );
      const boundaries = [...bytes.keys()].filter((index) => (bytes[index]! & 0xc0) === 0x80);
      const chunks = [];
      let start = 0;
      for (const index of boundaries) {
        chunks.push(bytes.subarray(start, index));
        start = index;
      }
      chunks.push(bytes.subarray(start));
      const response = postChunks(url, token, chunks);
      await expect
        .poll(() => events.find((event) => event.type === "request.opened"))
        .toBeDefined();
      const approval = events.find((event) => event.type === "request.opened")!;
      if (approval.type !== "request.opened") throw new Error("approval missing");
      expect(approval.payload.args).toMatchObject({
        path: path.join(await realpath(directory), filename),
        proposedContent: content,
      });
      await runtime.respondPermission(threadId, approval.requestId!, "accept");
      expect((await response).status).toBe(200);
      expect(await readFile(path.join(directory, filename), "utf8")).toBe(content);
      const offset = events.length;
      const malformed = await postChunks(url, token, [
        Buffer.from('{"path":"'),
        Buffer.from([0xc3, 0x28]),
        Buffer.from('"}'),
      ]);
      expect(malformed.status).toBe(400);
      expect(malformed.body).toContain("encoded data");
      const oversized = await postChunks(url, token, [Buffer.from("é".repeat(500001))]);
      expect(oversized.status).toBe(400);
      expect(oversized.body).toContain("body exceeds bound");
      expect(events.slice(offset).some((event) => event.type === "request.opened")).toBe(false);
    } finally {
      await runtime.close();
      await transport.close();
    }
  });
}, 30_000);
