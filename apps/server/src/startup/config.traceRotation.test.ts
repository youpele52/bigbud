import { describe, expect, it } from "vitest";

import {
  DEFAULT_TRACE_MAX_BYTES,
  DEFAULT_TRACE_MAX_FILES,
  REMOTE_TRACE_MAX_BYTES,
  REMOTE_TRACE_MAX_FILES,
  resolveTraceRotation,
} from "./config.traceRotation.ts";

const unset = { maxBytes: undefined, maxFiles: undefined };

describe("resolveTraceRotation", () => {
  it("uses the smaller remote profile defaults in remote mode", () => {
    expect(resolveTraceRotation("remote", unset)).toEqual({
      traceMaxBytes: REMOTE_TRACE_MAX_BYTES,
      traceMaxFiles: REMOTE_TRACE_MAX_FILES,
    });
    expect(REMOTE_TRACE_MAX_BYTES * (REMOTE_TRACE_MAX_FILES + 1)).toBeLessThanOrEqual(
      40 * 1024 * 1024,
    );
  });

  it("keeps the desktop and web defaults unchanged", () => {
    for (const mode of ["web", "desktop"] as const) {
      expect(resolveTraceRotation(mode, unset)).toEqual({
        traceMaxBytes: DEFAULT_TRACE_MAX_BYTES,
        traceMaxFiles: DEFAULT_TRACE_MAX_FILES,
      });
    }
  });

  it("lets explicit environment values win in every mode", () => {
    expect(resolveTraceRotation("remote", { maxBytes: 1024, maxFiles: 2 })).toEqual({
      traceMaxBytes: 1024,
      traceMaxFiles: 2,
    });
  });
});
