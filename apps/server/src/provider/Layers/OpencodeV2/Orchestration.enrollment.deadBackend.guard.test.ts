import { expect, it, vi } from "vitest";
import { runV2Cleanup } from "./Client.guard.ts";
import { makeV2Client } from "./Client.ts";
import { makeV2DeadBackendContext } from "./Orchestration.enrollment.deadBackend.ts";
import type { V2BackendInstance } from "./Orchestration.instances.ts";

const transport = "/synthetic/service.json";
const owned = "ses_owned";

function guardedClient(active: Record<string, { type: "running" }>) {
  const nativeFetch = vi.fn(async (request: Parameters<typeof fetch>[0]) => {
    const url = new URL(request instanceof Request ? request.url : String(request));
    if (url.pathname !== "/api/session/active") return new Response(null, { status: 404 });
    return Response.json({ data: active });
  });
  const client = makeV2Client({
    endpoint: "http://127.0.0.1:49993",
    sharedTransport: transport,
    fetch: Object.assign(nativeFetch, { preconnect: () => {} }) as typeof fetch,
  });
  const context = makeV2DeadBackendContext({
    instance: {} as V2BackendInstance,
    fence: undefined,
    privateKey: "",
    client,
    transport,
  });
  return { client, context, nativeFetch };
}

it("dead-backend idle proof reads the official running-session map under shared-transport cleanup", async () => {
  const idle = guardedClient({ ses_other: { type: "running" } });
  await expect(
    runV2Cleanup(transport, owned, () =>
      idle.context.nativeSessionActive(owned, new AbortController().signal),
    ),
  ).resolves.toBe(false);
  const busy = guardedClient({ [owned]: { type: "running" } });
  await expect(
    runV2Cleanup(transport, owned, () =>
      busy.context.nativeSessionActive(owned, new AbortController().signal),
    ),
  ).resolves.toBe(true);
  expect(idle.nativeFetch).toHaveBeenCalledTimes(1);
  expect(busy.nativeFetch).toHaveBeenCalledTimes(1);
});

it("cleanup still rejects other session-wide routes before dispatch", async () => {
  const { client, nativeFetch } = guardedClient({});
  await expect(runV2Cleanup(transport, owned, () => client.session.list())).rejects.toThrow(
    "V2 original-owner cleanup route rejected.",
  );
  expect(nativeFetch).not.toHaveBeenCalled();
});
