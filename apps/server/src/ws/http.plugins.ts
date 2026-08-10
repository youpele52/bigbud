import Mime from "@effect/platform-node/Mime";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { Effect, FileSystem, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { PluginRegistry } from "../plugins/Services/PluginRegistry";
import { serveLocalFile } from "./http.fileResponse";

const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

async function hasMatchingImageSignature(file: string): Promise<boolean> {
  const extension = extname(file).toLowerCase();
  const bytes = (await readFile(file)).subarray(0, 512);
  if (extension === ".png")
    return bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (extension === ".jpg" || extension === ".jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8;
  if (extension === ".webp")
    return (
      bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP"
    );
  if (extension === ".svg")
    return /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/iu.test(
      bytes.toString("utf8"),
    );
  return false;
}

export const pluginAssetRouteLayer = HttpRouter.add(
  "GET",
  "/api/plugins/assets",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });

    const scope = url.value.searchParams.get("scope");
    const revision = url.value.searchParams.get("revision");
    const pluginId = url.value.searchParams.get("pluginId");
    const assetKey = url.value.searchParams.get("assetKey");
    if (
      (scope !== "catalog" && scope !== "installed") ||
      !revision ||
      !pluginId ||
      (assetKey !== "composerIcon" && assetKey !== "logo" && assetKey !== "logoDark")
    ) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const registry = yield* Effect.serviceOption(PluginRegistry);
    if (Option.isNone(registry)) return HttpServerResponse.text("Not Found", { status: 404 });
    const assetPath = yield* registry.value.resolveAsset({ scope, revision, pluginId, assetKey });
    if (!assetPath) return HttpServerResponse.text("Not Found", { status: 404 });

    const fileSystem = yield* FileSystem.FileSystem;
    const info = yield* fileSystem.stat(assetPath).pipe(Effect.catch(() => Effect.succeed(null)));
    if (!info || info.type !== "File") return HttpServerResponse.text("Not Found", { status: 404 });
    const signatureMatches = yield* Effect.tryPromise({
      try: () => hasMatchingImageSignature(assetPath),
      catch: () => false,
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    if (!signatureMatches) return HttpServerResponse.text("Not Found", { status: 404 });
    return yield* serveLocalFile({
      request,
      filePath: assetPath,
      fileSize: Number(info.size),
      headers: {
        "Cache-Control": ASSET_CACHE_CONTROL,
        "Content-Type": Mime.getType(assetPath) ?? "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }),
);
