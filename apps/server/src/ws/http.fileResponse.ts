import { open } from "node:fs/promises";

import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

export interface LocalFileResponseHeaders {
  readonly "Cache-Control"?: string;
  readonly "Content-Type"?: string;
}

export interface ParsedByteRange {
  readonly start: number;
  readonly end: number;
}

export function parseByteRangeHeader(
  rangeHeader: string | undefined,
  fileSize: number,
): ParsedByteRange | "unsatisfiable" | null {
  if (!rangeHeader || !rangeHeader.startsWith("bytes=")) {
    return null;
  }

  const rangeSpec = rangeHeader.slice(6).split(",", 1)[0]?.trim();
  if (!rangeSpec) {
    return null;
  }

  const match = /^(\d*)-(\d*)$/.exec(rangeSpec);
  if (!match) {
    return null;
  }

  const startStr = match[1] ?? "";
  const endStr = match[2] ?? "";
  let start: number;
  let end: number;

  if (startStr.length === 0 && endStr.length > 0) {
    const suffixLength = Number(endStr);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else {
    start = startStr.length === 0 ? 0 : Number(startStr);
    end = endStr.length === 0 ? fileSize - 1 : Number(endStr);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) {
    return null;
  }

  if (start >= fileSize) {
    return "unsatisfiable";
  }

  end = Math.min(end, fileSize - 1);
  if (end < start) {
    return null;
  }

  return { start, end };
}

export const serveLocalFile = Effect.fn("http.serveLocalFile")(function* (input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly filePath: string;
  readonly fileSize: number;
  readonly headers: LocalFileResponseHeaders;
}) {
  const rangeHeader = input.request.headers["range"];
  const parsedRange = parseByteRangeHeader(rangeHeader, input.fileSize);
  const responseHeaders = {
    ...input.headers,
    "Accept-Ranges": "bytes",
  };

  if (parsedRange === "unsatisfiable") {
    return HttpServerResponse.text("Range Not Satisfiable", {
      status: 416,
      headers: {
        "Content-Range": `bytes */${input.fileSize}`,
      },
    });
  }

  if (parsedRange === null) {
    return yield* HttpServerResponse.file(input.filePath, {
      status: 200,
      headers: responseHeaders,
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }

  const { start, end } = parsedRange;
  const chunkSize = end - start + 1;
  const data = yield* Effect.promise(async () => {
    const handle = await open(input.filePath, "r");
    try {
      const buffer = Buffer.alloc(chunkSize);
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, start);
      return new Uint8Array(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  });

  return HttpServerResponse.uint8Array(data, {
    status: 206,
    contentType: input.headers["Content-Type"] ?? "application/octet-stream",
    headers: {
      ...(input.headers["Cache-Control"]
        ? { "Cache-Control": input.headers["Cache-Control"] }
        : {}),
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${start}-${end}/${input.fileSize}`,
      "Content-Length": String(data.byteLength),
    },
  });
});
