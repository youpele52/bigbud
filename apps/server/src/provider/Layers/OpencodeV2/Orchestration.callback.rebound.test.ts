import { createServer } from "node:http";
import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { makeV2ThreadPluginHost } from "./Orchestration.plugin.host.fixture.ts";

it("rebound listener cannot expose primary tools, forge invocation success, or read callback token/native arguments during a still-live lease", async () => {
  const app = await makeV2ThreadPluginFixture();
  const owner = app.bind("retained-live-native", app.root);
  const host = makeV2ThreadPluginHost(owner);
  const dispose = await (await import(app.artifact.entryUri)).default.setup(host.context);
  const received: { headers: unknown; body: string }[] = [];
  const replacement = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({ headers: request.headers, body: Buffer.concat(chunks).toString() });
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ active: true, ok: true, result: { delivery: "started" } }));
  });
  try {
    await host.call("enroll", app.envelope("enroll", 1, Date.now() + 55000));
    expect(Object.keys((await host.request(owner.nativeSessionId)).tools)).toHaveLength(5);
    await app.closeCallback(); // No native detach: the original native lease is intentionally still live.
    await new Promise<void>((resolve) =>
      replacement.listen(Number(new URL(owner.callbackUrl).port), "127.0.0.1", resolve),
    );
    await expect(host.request(owner.nativeSessionId)).rejects.toThrow("Required");
    // A disposed listener may leave a stale pooled socket; prove a real replacement HTTP 200,
    // not merely the first read-only hook's connection failure.
    if (received.length === 0)
      await expect(host.request(owner.nativeSessionId)).rejects.toThrow("Required");
    expect(received).toHaveLength(1);
    const tool = host.tools.get(`bb2_${app.artifact.issuer.slice(0, 32)}_send_thread_message`)!;
    await expect(
      tool.execute(
        { threadId: "SECRET-TARGET", message: "SECRET-MESSAGE" },
        {
          sessionID: owner.nativeSessionId,
          messageID: "SECRET-ASSISTANT",
          id: "SECRET-CALL",
          agent: "build",
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow("Required");
    expect(received).toHaveLength(2);
    for (const request of received) {
      expect(request.headers).not.toHaveProperty("authorization");
      expect(request.body).not.toContain(owner.callbackToken);
      expect(request.body).not.toContain(owner.enrollmentNonce);
      expect(request.body).not.toContain("SECRET");
      expect(JSON.parse(request.body)).toMatchObject({
        protocol: "bigbud.thread.encrypted.v1",
        ephemeralKey: expect.any(String),
        ciphertext: expect.any(String),
      });
    }
    expect(JSON.parse(received[0]!.body).ephemeralKey).not.toBe(
      JSON.parse(received[1]!.body).ephemeralKey,
    );
  } finally {
    replacement.closeAllConnections();
    if (replacement.listening)
      await new Promise<void>((resolve) => replacement.close(() => resolve()));
    await dispose();
    await app.close();
  }
});
