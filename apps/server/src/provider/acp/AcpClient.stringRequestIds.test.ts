import { Effect, Queue, Sink, Stdio, Stream } from "effect";
import * as AcpClient from "effect-acp/client";
import { expect, it } from "vitest";

/**
 * Agents may use string JSON-RPC ids (Devin uses UUIDs) for agent-to-client
 * requests. The client must answer them with the exact same id instead of
 * crashing its RPC server on `BigInt(id)`; decimal ids keep working.
 */
it("answers agent requests with string and numeric JSON-RPC ids using the same id", async () => {
  const replies = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const incoming = yield* Queue.unbounded<Uint8Array>();
        const written: string[] = [];
        const stdio = Stdio.make({
          args: Effect.succeed([]),
          stdin: Stream.fromQueue(incoming),
          stdout: () =>
            Sink.forEach((chunk: string | Uint8Array) =>
              Effect.sync(() => {
                written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
              }),
            ),
          stderr: () => Sink.drain,
        });
        const client = yield* AcpClient.make(stdio);
        yield* client.handleReadTextFile((request) =>
          Effect.succeed({ content: `read ${request.path}` }),
        );
        const send = (message: unknown) =>
          Queue.offer(incoming, new TextEncoder().encode(`${JSON.stringify(message)}\n`));
        const request = (id: string | number, path: string) => ({
          jsonrpc: "2.0",
          id,
          method: "fs/read_text_file",
          params: { sessionId: "session-1", path },
        });
        yield* send(request("addce8be-f313-4d00-a205-6d92be3173f4", "/a"));
        yield* send(request(7, "/b"));
        yield* send(request("second-string-id", "/c"));
        const replies = () =>
          written
            .join("")
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line) as { id: unknown; result?: { content?: string } });
        for (let attempt = 0; attempt < 200 && replies().length < 3; attempt += 1)
          yield* Effect.sleep("10 millis");
        return replies();
      }),
    ),
  );
  const byId = new Map(replies.map((reply) => [reply.id, reply.result?.content]));
  expect(byId.get("addce8be-f313-4d00-a205-6d92be3173f4")).toBe("read /a");
  expect(byId.get(7)).toBe("read /b");
  expect(byId.get("second-string-id")).toBe("read /c");
  expect(replies).toHaveLength(3);
});
