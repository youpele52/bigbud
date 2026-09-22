import { describe, expect, it } from "vitest";

import { getDesktopStartupFailureDescription } from "./WebSocketConnectionSurface.blocking";

describe("WebSocketConnectionSurface blocking startup copy", () => {
  it("explains how to repair an invalid packaged backend", () => {
    expect(
      getDesktopStartupFailureDescription({
        failureReason: "backend_modules_invalid",
        generation: 1,
        startedAt: 0,
        status: "failed",
      }),
    ).toBe(
      "The local backend installation is incomplete or damaged. Reinstalling bigbud repairs it.",
    );
  });
});
