import type { SessionInfo } from "@opencode/client";
import { makeV2Client } from "./Client.ts";
const reply = (value: unknown) => Response.json(value);

export const textGenerationSelection = {
  provider: "opencodeV2",
  subProviderID: "exact-account",
  model: "exact-model",
  options: { variant: "reasoning" },
} as const;

/** Synthetic public HTTP ABI: creation accepts bodies; session paths enforce the native 100-char limit. */
export function makeTextGenerationHttpFixture(directory = "/fixture") {
  const sessions = new Map<string, SessionInfo>();
  const requests: Array<{ method: string; pathname: string; body: Record<string, any> }> = [];
  const options = {
    text: JSON.stringify({ title: "Repair native text generation" }),
    generate: undefined as (() => Promise<string>) | undefined,
    corruptSession: false,
    failDelete: false,
    failGenerate: false,
    available: true,
    closed: 0,
  };
  const fetchImplementation = (async (raw, init) => {
    const url = new URL(raw instanceof Request ? raw.url : String(raw));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ method, pathname: url.pathname, body });
    if (url.pathname === "/api/model")
      return reply({
        location: { directory },
        data: [
          {
            providerID: "exact-account",
            id: "exact-model",
            enabled: options.available,
            variants: [{ id: "reasoning" }],
            capabilities: { input: ["text"], output: ["text"], tools: true },
          },
        ],
      });
    if (url.pathname === "/api/session" && method === "POST") {
      const native = { ...body, location: body.location } as SessionInfo;
      sessions.set(native.id, native);
      return reply({ data: native });
    }
    if (url.pathname === "/api/session" && method === "GET")
      return reply({ data: [...sessions.values()], cursor: { next: null } });
    const match = /^\/api\/session\/([^/]+)(\/generate)?$/.exec(url.pathname);
    if (!match || match[1]!.length > 100) return new Response(null, { status: 404 });
    const native = sessions.get(match[1]!);
    if (!native) return new Response(null, { status: 404 });
    if (match[2]) {
      if (options.failGenerate) throw new Error("secret credential and prompt must never escape");
      return reply({
        data: { text: options.generate ? await options.generate() : options.text },
      });
    }
    if (method === "GET")
      return reply({
        data: options.corruptSession
          ? { ...native, metadata: { ...native.metadata, bigbud_issuer: "foreign" } }
          : native,
      });
    if (method === "DELETE") {
      if (options.failDelete) return new Response(null, { status: 500 });
      sessions.delete(native.id);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 400 });
  }) as typeof fetch;
  const client = makeV2Client({
    endpoint: "http://127.0.0.1:4096",
    fetch: fetchImplementation,
  });
  return {
    fetch: fetchImplementation,
    client,
    sessions,
    requests,
    options,
    connect: async () => ({
      client,
      storageIdentity: "verified-storage",
      descriptor: {
        storageIdentity: "verified-storage",
        registrationFile: "/synthetic/service.json",
        generation: "synthetic-generation",
      },
      close: async () => {
        options.closed++;
      },
    }),
  };
}
