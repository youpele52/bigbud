import { GAMES } from "@bigbud/shared/games";
import { Effect, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

const MAX_HTML_BYTES = 128_000;

function decodeText(value: string): string {
  return value
    .replaceAll(/&(#(?:x[\da-f]+|\d+)|amp|quot|apos|lt|gt);/giu, (_, entity: string) => {
      const entities: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
      if (entity.startsWith("#")) {
        const codepoint = Number.parseInt(
          entity.slice(entity[1]?.toLowerCase() === "x" ? 2 : 1),
          entity[1]?.toLowerCase() === "x" ? 16 : 10,
        );
        return codepoint > 0 && codepoint <= 0x10ffff ? String.fromCodePoint(codepoint) : "";
      }
      return entities[entity.toLowerCase()] ?? "";
    })
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, 200);
}

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

export function parseGameMetadata(html: string, destination: string) {
  const origin = new URL(destination).origin;
  let title = decodeText(html.match(/<title\b[^>]*>([^<]*)<\/title>/iu)?.[1] ?? "");
  let description = "";
  let faviconUrl: string | null = null;
  for (const tag of html.match(/<(?:meta|link)\b[^>]*>/giu) ?? []) {
    const name = (attribute(tag, "name") ?? attribute(tag, "property") ?? "").toLowerCase();
    if (name === "og:title" && !title) title = decodeText(attribute(tag, "content") ?? "");
    if ((name === "description" || name === "og:description") && !description)
      description = decodeText(attribute(tag, "content") ?? "");
    if (/\bicon\b/iu.test(attribute(tag, "rel") ?? "") && !faviconUrl) {
      try {
        const icon = new URL(decodeText(attribute(tag, "href") ?? ""), destination);
        if (icon.protocol === "https:" && icon.origin === origin) faviconUrl = icon.href;
      } catch {
        /* An invalid icon leaves the safe fallback. */
      }
    }
  }
  return { title, description, faviconUrl: faviconUrl ?? `${origin}/favicon.ico` };
}

/** Fetches only an approved destination, with bounded time, bytes, and redirect scope. */
export async function fetchGameMetadata(
  destination: string,
  fetcher: (url: string, options?: RequestInit) => Promise<Response> = fetch,
) {
  const origin = new URL(destination).origin;
  let current = destination;
  for (let redirects = 0; redirects < 3; redirects++) {
    const response = await fetcher(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(4500),
      headers: { Accept: "text/html" },
    });
    if (response.status >= 300 && response.status < 400) {
      const next = new URL(response.headers.get("location") ?? "", current);
      await response.body?.cancel();
      if (next.origin !== origin || next.protocol !== "https:")
        throw new Error("Untrusted redirect");
      current = next.href;
      continue;
    }
    if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("text/html"))
      throw new Error("No HTML metadata available");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing response body");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = MAX_HTML_BYTES - bytes;
        chunks.push(value.subarray(0, remaining));
        bytes += Math.min(value.byteLength, remaining);
        if (bytes >= MAX_HTML_BYTES || new TextDecoder().decode(value).includes("</head>")) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return parseGameMetadata(new TextDecoder().decode(Buffer.concat(chunks)), current);
  }
  throw new Error("Too many redirects");
}

export const gameMetadataRouteLayer = HttpRouter.add(
  "GET",
  "/api/games/metadata",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
    const game = GAMES.find((candidate) => candidate.url === url.value.searchParams.get("url"));
    if (!game) return HttpServerResponse.text("Not Found", { status: 404 });
    const metadata = yield* Effect.tryPromise(() => fetchGameMetadata(game.url)).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    return yield* HttpServerResponse.json(
      metadata ?? {
        title: game.name,
        description: game.description,
        faviconUrl: `${new URL(game.url).origin}/favicon.ico`,
      },
      { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
    );
  }),
);
