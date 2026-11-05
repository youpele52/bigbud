import { expect, it, vi } from "vitest";
import { makeV2Client } from "./Client.ts";
import { boundV2Response } from "./Client.response.ts";
import { deferred } from "./Test.fixtures.ts";

const info = { version: "2.2.5", pid: 123, urls: [], paths: { tmp: "/fixture" } };

it("rejects a response from a retired generation without retrying the dispatched request", async () => {
  const pending = deferred<Response>();
  const dispatched = deferred<void>();
  const native = vi.fn(async () => {
    dispatched.resolve();
    return pending.promise;
  });
  let current = true;
  const client = makeV2Client({
    endpoint: "http://127.0.0.1:4000",
    fetch: Object.assign(native, { preconnect: () => {} }) as typeof fetch,
    afterResponse: async () => {
      if (!current) throw new Error("retired generation");
    },
  });
  const operation = client.server.info();
  const rejected = expect(operation).rejects.toThrow();
  await dispatched.promise;
  current = false;
  pending.resolve(Response.json(info));
  await rejected;
  expect(native).toHaveBeenCalledTimes(1);
});

it("fences body chunks and final decoding even after response headers were accepted", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let current = true;
  const response = boundV2Response(
    new Response(
      new ReadableStream({
        start: (value) => {
          controller = value;
        },
      }),
    ),
    undefined,
    async () => {
      if (!current) throw new Error("retired generation");
    },
  );
  const reading = response.json();
  const rejected = expect(reading).rejects.toThrow("retired generation");
  controller.enqueue(new TextEncoder().encode(JSON.stringify(info)));
  current = false;
  controller.close();
  await rejected;
});

it("rejects later stream frames and closes the old source", async () => {
  let current = true;
  const source = deferred<void>();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = boundV2Response(
    new Response(
      new ReadableStream({
        start: (value) => {
          controller = value;
        },
        cancel: () => {
          source.resolve();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
    undefined,
    async () => {
      if (!current) throw new Error("retired generation");
    },
  );
  const reader = response.body!.getReader();
  controller.enqueue(new TextEncoder().encode("data: first\n\n"));
  expect((await reader.read()).done).toBe(false);
  current = false;
  controller.enqueue(new TextEncoder().encode("data: stale\n\n"));
  await expect(reader.read()).rejects.toThrow("retired generation");
  await source.promise;
});

it("aborts local in-flight fetches when their borrowed connection closes", async () => {
  const controller = new AbortController();
  const dispatched = deferred<void>();
  let observed: AbortSignal | null | undefined;
  const client = makeV2Client({
    endpoint: "http://127.0.0.1:4000",
    signal: controller.signal,
    fetch: Object.assign(
      async (_request: unknown, init?: RequestInit) => {
        observed = init?.signal;
        dispatched.resolve();
        return new Promise<Response>((_resolve, reject) => {
          observed!.addEventListener("abort", () => reject(new Error("detached")), { once: true });
        });
      },
      { preconnect: () => {} },
    ) as typeof fetch,
  });
  const rejected = expect(client.server.info()).rejects.toThrow();
  await dispatched.promise;
  controller.abort();
  await rejected;
  expect(observed?.aborted).toBe(true);
});
