import { expect, it } from "vitest";

import { boundV2Response } from "./Client.response.ts";

it("bounds JSON before decoding rather than after allocation", async () => {
  await expect(boundV2Response(new Response("123456"), 5).text()).rejects.toThrow("safety bound");
  expect(await boundV2Response(new Response("12345"), 5).text()).toBe("12345");
});

it("limits each SSE frame across chunk boundaries, not the stream lifetime", async () => {
  const response = (chunks: string[]) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  expect(await boundV2Response(response(["data: 1\r\n\r\n", "data: 2\n\n"]), 16).text()).toContain(
    "data: 2",
  );
  await expect(
    boundV2Response(response(["data: ", "1234567890", "overflow"]), 16).text(),
  ).rejects.toThrow("safety bound");
});
