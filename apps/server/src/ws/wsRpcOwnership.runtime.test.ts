import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("pinned RPC repair runtime parity", () => {
  it("resolves the compiled exports actually used by packaged bundles", () => {
    const serverPath = require.resolve("effect/unstable/rpc/RpcServer");
    const clientPath = require.resolve("effect/unstable/rpc/RpcClient");
    expect(serverPath).toContain("/dist/unstable/rpc/RpcServer.js");
    expect(clientPath).toContain("/dist/unstable/rpc/RpcClient.js");
    const server = readFileSync(serverPath, "utf8");
    const client = readFileSync(clientPath, "utf8");
    expect(server).toContain("Effect.andThen(start.await, effect)");
    expect(server.indexOf("client.fibers.set(request.id, fiber)")).toBeLessThan(
      server.indexOf("start.openUnsafe()"),
    );
    expect(server.indexOf("fiber.addObserver(exit =>")).toBeLessThan(
      server.indexOf("start.openUnsafe()"),
    );
    expect(server).toContain("if (isChunk) return Effect.die(defect)");
    expect(server).toContain("Effect.andThen(close, write)");
    expect(client).toContain("yield* entry.cancel()");
    expect(client).toContain("return cancelRequest(message.requestId)");
    expect(client).toContain(
      "Effect.catchCause(cause => Effect.andThen(Effect.ignore(cancelRequest(requestId))",
    );
  });
});
