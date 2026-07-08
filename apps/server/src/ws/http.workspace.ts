import Mime from "@effect/platform-node/Mime";
import { Effect, FileSystem, Option, Path } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerConfig } from "../startup/config";
import { WorkspacePaths } from "../workspace/Services/WorkspacePaths.ts";
import { serveLocalFile } from "./http.fileResponse.ts";

const WORKSPACE_FILE_PREVIEW_CACHE_CONTROL = "no-store";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildWorkspacePdfViewerHtml(input: { title: string; pdfUrl: string }): string {
  const escapedTitle = escapeHtml(input.title);
  const escapedPdfUrl = escapeHtml(input.pdfUrl);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapedTitle}</title>
    <style>
      :root {
        color-scheme: dark;
      }
      html,
      body {
        margin: 0;
        width: 100%;
        height: 100%;
        background: #0f0f10;
      }
      .viewer {
        width: 100%;
        height: 100%;
        border: 0;
        display: block;
        background: #161617;
      }
      .fallback {
        position: fixed;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 24px;
        color: #e6e6e6;
        font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;
      }
      .fallback-inner {
        max-width: 32rem;
        text-align: center;
      }
      .fallback a {
        color: #9ecbff;
      }
    </style>
  </head>
  <body>
    <embed class="viewer" src="${escapedPdfUrl}#toolbar=0&navpanes=0&scrollbar=1" type="application/pdf" />
    <div class="fallback">
      <div class="fallback-inner">
        <p>This PDF could not be displayed in the embedded viewer.</p>
        <p><a href="${escapedPdfUrl}" target="_self" rel="noreferrer">Open the raw PDF</a></p>
      </div>
    </div>
    <script>
      const viewer = document.querySelector(".viewer");
      const fallback = document.querySelector(".fallback");
      const showFallback = () => {
        if (!(fallback instanceof HTMLElement) || !(viewer instanceof HTMLElement)) return;
        viewer.style.display = "none";
        fallback.style.display = "flex";
      };
      window.setTimeout(showFallback, 1500);
      viewer?.addEventListener?.("load", () => {
        if (!(fallback instanceof HTMLElement)) return;
        fallback.style.display = "none";
      });
    </script>
  </body>
</html>`;
}

const resolveWorkspacePreviewFile = Effect.fn("http.resolveWorkspacePreviewFile")(function* (
  projectCwd: string,
  relativePath: string,
) {
  const workspacePaths = yield* WorkspacePaths;
  const resolvedPath = yield* workspacePaths.normalizeWorkspaceRoot(projectCwd).pipe(
    Effect.flatMap((workspaceRoot) =>
      workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot,
        relativePath,
      }),
    ),
    Effect.catch(() => Effect.succeed(null)),
  );

  if (!resolvedPath) {
    return null;
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const fileInfo = yield* fileSystem
    .stat(resolvedPath.absolutePath)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (!fileInfo || fileInfo.type !== "File") {
    return null;
  }

  return resolvedPath;
});

export const workspaceFilePreviewRouteLayer = HttpRouter.add(
  "GET",
  "/api/workspace-file-preview",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const projectCwd = url.value.searchParams.get("cwd");
    const relativePath = url.value.searchParams.get("relativePath");
    if (!projectCwd || !relativePath) {
      return HttpServerResponse.text("Missing cwd or relativePath parameter", { status: 400 });
    }

    const resolvedPath = yield* resolveWorkspacePreviewFile(projectCwd, relativePath);
    if (!resolvedPath) {
      return HttpServerResponse.text("Invalid workspace file path", { status: 400 });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* fileSystem
      .stat(resolvedPath.absolutePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      return HttpServerResponse.text("Invalid workspace file path", { status: 400 });
    }

    return yield* serveLocalFile({
      request,
      filePath: resolvedPath.absolutePath,
      fileSize: Number(fileInfo.size),
      headers: {
        "Cache-Control": WORKSPACE_FILE_PREVIEW_CACHE_CONTROL,
        "Content-Type": Mime.getType(resolvedPath.absolutePath) ?? "application/octet-stream",
      },
    });
  }),
);

export const workspacePdfViewerRouteLayer = HttpRouter.add(
  "GET",
  "/api/workspace-pdf-viewer",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const projectCwd = url.value.searchParams.get("cwd");
    const relativePath = url.value.searchParams.get("relativePath");
    if (!projectCwd || !relativePath) {
      return HttpServerResponse.text("Missing cwd or relativePath parameter", { status: 400 });
    }

    const resolvedPath = yield* resolveWorkspacePreviewFile(projectCwd, relativePath);
    if (!resolvedPath) {
      return HttpServerResponse.text("Invalid workspace file path", { status: 400 });
    }

    const pdfUrl = `/api/workspace-file-preview?cwd=${encodeURIComponent(projectCwd)}&relativePath=${encodeURIComponent(relativePath)}`;
    const path = yield* Path.Path;
    return HttpServerResponse.text(
      buildWorkspacePdfViewerHtml({
        title: path.basename(resolvedPath.absolutePath),
        pdfUrl,
      }),
      {
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: {
          "Cache-Control": WORKSPACE_FILE_PREVIEW_CACHE_CONTROL,
        },
      },
    );
  }),
);

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    if (config.devUrl) {
      return HttpServerResponse.redirect(config.devUrl.href, { status: 302 });
    }

    if (!config.staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(config.staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
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

    const contentType = Mime.getType(filePath) ?? "application/octet-stream";
    const data = yield* fileSystem
      .readFile(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType,
    });
  }),
);
