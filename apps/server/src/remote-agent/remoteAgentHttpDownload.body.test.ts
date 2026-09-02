import { describe, expect, it, vi } from "vitest";

import {
  readRemoteAgentDownloadBody,
  RemoteAgentDownloadAttemptFailure,
} from "./remoteAgentHttpDownload.attempt.ts";

function responseWithTrackedBody(contentLength?: string, cancelError?: Error) {
  const cancel = vi.fn(() => {
    if (cancelError) throw cancelError;
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.close();
    },
    cancel,
  });
  const response = new Response(
    body,
    contentLength === undefined ? {} : { headers: { "content-length": contentLength } },
  );
  return { response, cancel };
}

describe("remote agent HTTP response body disposal", () => {
  it.each([
    ["malformed", "invalid", 16, undefined],
    ["negative", "-1", 16, undefined],
    ["unsafe", "9007199254740992", Number.MAX_SAFE_INTEGER, undefined],
    ["oversized", "17", 16, undefined],
    ["signed size mismatch", "3", 16, 2],
  ])("cancels the body once for a %s Content-Length", async (_label, length, maximum, expected) => {
    const fixture = responseWithTrackedBody(length);

    await expect(
      readRemoteAgentDownloadBody(fixture.response, maximum, expected),
    ).rejects.toBeInstanceOf(RemoteAgentDownloadAttemptFailure);
    expect(fixture.cancel).toHaveBeenCalledOnce();
  });

  it("preserves the validation failure when cancellation rejects", async () => {
    const cleanupError = new Error("cleanup failed");
    const fixture = responseWithTrackedBody("invalid", cleanupError);

    const failure = await readRemoteAgentDownloadBody(fixture.response, 16).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(RemoteAgentDownloadAttemptFailure);
    expect(failure).not.toBe(cleanupError);
    expect(fixture.cancel).toHaveBeenCalledOnce();
  });

  it("has nothing to cancel when the response body is missing", async () => {
    await expect(
      readRemoteAgentDownloadBody(
        new Response(null, { headers: { "content-length": "invalid" } }),
        16,
      ),
    ).rejects.toMatchObject({ stage: "headers" });
  });

  it("does not cancel a successfully consumed body", async () => {
    const fixture = responseWithTrackedBody("2");

    await expect(readRemoteAgentDownloadBody(fixture.response, 16, 2)).resolves.toEqual(
      new Uint8Array([1, 2]),
    );
    expect(fixture.cancel).toHaveBeenCalledTimes(0);
  });
});
