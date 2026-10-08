import { expect, it, vi } from "vitest";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { readV2Messages } from "./Runtime.projection.ts";
import { V2ResponseSizeError } from "./Client.response.ts";

it("oversized retained-media pages narrow only their read window, retain identities, and never redispatch admission", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const threadId = ThreadId.makeUnsafe("media-history");
    await runtime.start({
      threadId,
      cwd: directory,
      runtimeMode: "approval-required",
      modelSelection: {
        provider: "opencodeV2",
        subProviderID: "synthetic-provider",
        model: "synthetic-model",
      },
    });
    const owner = runtime.get(threadId);
    const message = {
      id: "msg_retained",
      type: "user" as const,
      text: "retained",
      time: { created: 1 },
      metadata: { bigbud_fingerprint: "unchanged" },
    };
    const read = vi
      .spyOn(http.client.message, "list")
      .mockRejectedValueOnce(new V2ResponseSizeError())
      .mockResolvedValueOnce({ data: [message], cursor: { next: "end" } })
      .mockResolvedValueOnce({ data: [], cursor: {} });
    expect(await readV2Messages(owner)).toEqual([message]);
    expect(read.mock.calls.map(([input]) => input.limit)).toEqual([100, 1, 1]);
    expect(read.mock.calls[2]?.[0].cursor).toBe("end");
    expect(http.calls.some((call) => call.pathname.endsWith("/prompt"))).toBe(false);
  });
});

it("leaves an oversized single-message page unconfirmed instead of retrying the same bound", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const threadId = ThreadId.makeUnsafe("media-single-too-large");
    await runtime.start({
      threadId,
      cwd: directory,
      runtimeMode: "approval-required",
      modelSelection: {
        provider: "opencodeV2",
        subProviderID: "synthetic-provider",
        model: "synthetic-model",
      },
    });
    const read = vi.spyOn(http.client.message, "list").mockRejectedValue(new V2ResponseSizeError());
    await expect(readV2Messages(runtime.get(threadId))).rejects.toBeInstanceOf(V2ResponseSizeError);
    expect(read.mock.calls.map(([input]) => input.limit)).toEqual([100, 1]);
    expect(http.calls.some((call) => call.pathname.endsWith("/prompt"))).toBe(false);
  });
});

it.each([
  new Error("disconnected projection"),
  Object.assign(new Error("OpenCode v2 response exceeded the decoding safety bound."), {
    name: "V2ResponseSizeError",
  }),
])("does not disguise a transport or lookalike error as an oversized page: %j", async (error) => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const threadId = ThreadId.makeUnsafe("media-transport-error");
    await runtime.start({
      threadId,
      cwd: directory,
      runtimeMode: "approval-required",
      modelSelection: {
        provider: "opencodeV2",
        subProviderID: "synthetic-provider",
        model: "synthetic-model",
      },
    });
    const read = vi.spyOn(http.client.message, "list").mockRejectedValueOnce(error);
    await expect(readV2Messages(runtime.get(threadId))).rejects.toThrow(
      "admission may be unconfirmed",
    );
    expect(read.mock.calls.map(([input]) => input.limit)).toEqual([100]);
    expect(http.calls.some((call) => call.pathname.endsWith("/prompt"))).toBe(false);
  });
});
