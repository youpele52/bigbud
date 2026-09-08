import { describe, expect, it } from "vitest";

import { shouldPersistTraceRecord } from "./TracePolicy.ts";

const successRecord = {
  type: "effect-span" as const,
  name: "fast",
  traceId: "trace",
  spanId: "span",
  sampled: true,
  kind: "internal" as const,
  startTimeUnixNano: "1",
  endTimeUnixNano: "2",
  durationMs: 1,
  attributes: {},
  events: [],
  links: [],
  exit: { _tag: "Success" as const },
};

describe("TracePolicy", () => {
  it("expires diagnostic capture", () => {
    expect(
      shouldPersistTraceRecord(successRecord, {
        mode: "diagnostic",
        expiresAtMs: Date.now() - 1,
      }),
    ).toBe(false);
  });

  it("retains OTLP errors after diagnostic capture expires", () => {
    expect(
      shouldPersistTraceRecord(
        {
          type: "otlp-span",
          name: "browser-span",
          traceId: "trace",
          spanId: "span",
          sampled: true,
          kind: "internal",
          startTimeUnixNano: "1",
          endTimeUnixNano: "2",
          durationMs: 1,
          attributes: {},
          events: [],
          links: [],
          resourceAttributes: {},
          scope: { attributes: {} },
          status: { code: "STATUS_CODE_ERROR" },
        },
        { mode: "diagnostic", expiresAtMs: Date.now() - 1 },
      ),
    ).toBe(true);
  });
});
