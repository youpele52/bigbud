import Mime from "@effect/platform-node/Mime";
import { Effect, FileSystem, Option, Path } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerConfig } from "../startup/config";

const MOBILE_WEB_ROUTE_PREFIX = "/mobile";

function resolveMobileWebRelativePath(pathname: string): string | null {
  if (pathname === MOBILE_WEB_ROUTE_PREFIX || pathname === `${MOBILE_WEB_ROUTE_PREFIX}/`) {
    return "index.html";
  }
  if (!pathname.startsWith(`${MOBILE_WEB_ROUTE_PREFIX}/`)) {
    return null;
  }

  const relative = pathname.slice(`${MOBILE_WEB_ROUTE_PREFIX}/`.length);
  if (relative.length === 0 || relative.startsWith("..") || relative.includes("\0")) {
    return null;
  }

  const lastSegment = relative.split("/").at(-1) ?? relative;
  if (!lastSegment.includes(".")) {
    return "index.html";
  }

  return relative;
}

export const mobileWebStaticRouteLayer = HttpRouter.add(
  "GET",
  `${MOBILE_WEB_ROUTE_PREFIX}*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    if (!config.mobileWebStaticDir) {
      return HttpServerResponse.text("Mobile companion is not available on this server.", {
        status: 404,
      });
    }

    const relativePath = resolveMobileWebRelativePath(url.value.pathname);
    if (!relativePath) {
      return HttpServerResponse.text("Invalid mobile web path", { status: 400 });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(config.mobileWebStaticDir);
    const filePath = path.resolve(staticRoot, relativePath);
    const isWithinStaticRoot =
      filePath === staticRoot ||
      filePath.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);
    if (!isWithinStaticRoot) {
      return HttpServerResponse.text("Invalid mobile web path", { status: 400 });
    }

    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      const indexPath = path.resolve(staticRoot, "index.html");
      const indexData = yield* fileSystem
        .readFile(indexPath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!indexData) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return HttpServerResponse.uint8Array(indexData, {
        status: 200,
        contentType: "text/html; charset=utf-8",
      });
    }

    const data = yield* fileSystem
      .readFile(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType: Mime.getType(filePath) ?? "application/octet-stream",
    });
  }),
);
