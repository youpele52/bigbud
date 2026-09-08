import { ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { resolveSelectedThreadIdFromPath } from "./-__root.bounded-bootstrap";

describe("bounded bootstrap route selection", () => {
  it("never treats Plugins as a selected thread during recovery", () => {
    const fallback = ThreadId.makeUnsafe("selected-thread");

    expect(resolveSelectedThreadIdFromPath("/plugins", fallback)).toBe(fallback);
  });
});
