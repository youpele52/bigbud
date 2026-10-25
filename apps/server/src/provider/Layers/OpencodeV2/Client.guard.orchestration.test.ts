import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { makeV2Client } from "./Client.ts";
import { runV2RequestContext } from "./Client.guard.ts";
import { assertV2OrchestrationRpc, callV2ThreadRpc } from "./Client.guard.orchestration.ts";

const permit = {
  revision: 1,
  signal: new AbortController().signal,
  assertCurrent: () => {},
  release: () => {},
};
const transport = "/owned-service.json";
it("shared RPC defaults deny; only the exact serialized info route/Location/body authority can dispatch", async () => {
  const fetch = Object.assign(
    vi.fn(
      async () =>
        new Response(JSON.stringify({ output: { protocol: "bigbud.thread.v1" } }), {
          headers: { "content-type": "application/json" },
        }),
    ),
    { preconnect: () => {} },
  ) as unknown as typeof globalThis.fetch;
  const client = makeV2Client({
    endpoint: "http://127.0.0.1:45991",
    sharedTransport: transport,
    fetch,
  });
  await runV2RequestContext({ transport, permit, intent: "execute" }, async () => {
    await expect(
      client.rpc.call({
        rpcID: "bigbud.thread.v1",
        method: "info",
        location: { directory: "/workspace" },
        input: {},
      }),
    ).rejects.toThrow("authority");
    expect(fetch).not.toHaveBeenCalled();
    await expect(callV2ThreadRpc(client, "/workspace", "info", {})).resolves.toEqual({
      protocol: "bigbud.thread.v1",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it("wire tampering/extra Location queries and cleanup enrollment cannot broaden original owner authority", async () => {
  const body = JSON.stringify({ input: {} });
  const authority = {
    rpcID: "bigbud.thread.v1" as const,
    method: "info" as const,
    directory: "/workspace",
    bodyDigest: createHash("sha256").update(body).digest("hex"),
  };
  const context = { transport, permit, intent: "execute" as const, orchestration: authority };
  const url = new URL(
    "http://127.0.0.1:45991/api/rpc/bigbud.thread.v1/info?location[directory]=%2Fworkspace",
  );
  await expect(
    assertV2OrchestrationRpc(context, url, url.href, {
      method: "POST",
      body: '{"input":{"forged":true}}',
    }),
  ).rejects.toThrow("wire body");
  url.searchParams.append("location[directory]", "/foreign");
  await expect(
    assertV2OrchestrationRpc(context, url, url.href, { method: "POST", body }),
  ).rejects.toThrow("authority");
  url.searchParams.delete("location[directory]");
  url.searchParams.append("location[directory]", "/workspace");
  await expect(
    assertV2OrchestrationRpc(
      { ...context, intent: "cleanup", nativeSessionId: "old-owner" },
      url,
      url.href,
      { method: "POST", body },
    ),
  ).rejects.toThrow("cleanup");
});
