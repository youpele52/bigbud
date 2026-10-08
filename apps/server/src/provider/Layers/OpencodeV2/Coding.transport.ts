import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile, unlink, open, rename } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { V2CodingBridge } from "./Coding.bridge.ts";
import { renderV2CodingPlugin } from "./Coding.plugin.ts";
import { renderV2LegacyCodingPlugin } from "./Coding.plugin.legacy.ts";
import { resolveV2OptionalFilePython } from "./Coding.files.owner.ts";
import { inspectPrivateV2Profile } from "./ProfileIsolation.mjs";

/** Private loopback plugin endpoint. Model arguments cannot supply native session/message/call identity. */
export async function makeV2CodingTransport(profile: string) {
  const bridge = await V2CodingBridge.open(profile, await resolveV2OptionalFilePython(profile));
  const token = randomBytes(32).toString("hex");
  let active = 0,
    closed = false;
  const server = createServer(async (request, response) => {
    try {
      const auth = Buffer.from(request.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (
        closed ||
        request.method !== "POST" ||
        request.url !== "/invoke" ||
        auth.length !== expected.length ||
        !timingSafeEqual(auth, expected)
      ) {
        response.writeHead(403).end();
        return;
      }
      if (active >= 32) {
        response.writeHead(429).end();
        return;
      }
      active++;
      const controller = new AbortController();
      const cancelled = () => {
        if (!response.writableEnded) controller.abort();
      };
      response.once("close", cancelled);
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          const buffer = Buffer.from(chunk);
          bytes += buffer.byteLength;
          if (bytes > 1_000_000) throw new Error("V2 coding body exceeds bound.");
          chunks.push(buffer);
        }
        const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
        const result = await bridge.invoke(JSON.parse(body), controller.signal);
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
      } finally {
        response.off("close", cancelled);
        active--;
      }
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" }).end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "V2 coding request failed",
        }),
      );
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("V2 coding endpoint unavailable.");
  const directory = path.join(profile, "config", "opencode", "plugins");
  const pluginPath = path.join(directory, "bigbud-coding-owned.js");
  const source = renderV2CodingPlugin(`http://127.0.0.1:${address.port}/invoke`, token);
  try {
    await inspectPrivateV2Profile(profile, { marker: false });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await inspectPrivateV2Profile(profile, { marker: false });
    let existing;
    try {
      existing = await open(
        pluginPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (existing) {
      try {
        const info = await existing.stat();
        if (!info.isFile() || info.size > 20000 || info.nlink !== 1)
          throw new Error("V2 coding plugin collision.");
        const prior = await existing.readFile("utf8");
        const marker = "// bigbud-coding-owned-v1 ";
        if (!prior.startsWith(marker)) throw new Error("V2 coding plugin collision.");
        const metadata = JSON.parse(prior.split("\n")[0]!.slice(marker.length)) as {
          url: string;
          token: string;
        };
        const endpoint = new URL(metadata.url);
        if (
          endpoint.protocol !== "http:" ||
          endpoint.hostname !== "127.0.0.1" ||
          endpoint.pathname !== "/invoke" ||
          !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/invoke$/.test(metadata.url) ||
          !/^[0-9a-f]{64}$/.test(metadata.token)
        )
          throw new Error("V2 owned coding plugin upgrade rejected: invalid callback metadata.");
        if (
          prior !== renderV2CodingPlugin(metadata.url, metadata.token) &&
          prior !== renderV2LegacyCodingPlugin(metadata.url, metadata.token)
        )
          throw new Error(
            "V2 owned coding plugin upgrade rejected: content differs from exact supported templates.",
          );
      } finally {
        await existing.close();
      }
    }
    const temporary = `${pluginPath}.${randomBytes(16).toString("hex")}`;
    try {
      await writeFile(temporary, source, { mode: 0o600, flag: "wx" });
      await rename(temporary, pluginPath);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  } catch (error) {
    bridge.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  return {
    bridge,
    pluginPath,
    endpoint: { url: `http://127.0.0.1:${address.port}/invoke`, token },
    async close() {
      closed = true;
      bridge.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      let existing;
      try {
        existing = await open(
          pluginPath,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
      }
      try {
        if ((await existing.stat()).size <= 20000 && (await existing.readFile("utf8")) === source)
          await unlink(pluginPath);
      } finally {
        await existing.close();
      }
    },
  };
}
