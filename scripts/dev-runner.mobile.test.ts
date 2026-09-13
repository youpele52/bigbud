import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { DEFAULT_WEB_PORT } from "@bigbud/shared/DevPorts";

import { resolveModePortOffsets } from "./dev-runner.ts";

describe("mobile development port wiring", () => {
  it.effect("keeps the companion URL at the instance offset when the web port shifts", () =>
    Effect.gen(function* () {
      const offsets = yield* resolveModePortOffsets({
        mode: "dev:desktop",
        startOffset: 0,
        hasExplicitServerPort: false,
        hasExplicitDevUrl: false,
        checkPortAvailability: (port) => Effect.succeed(port !== DEFAULT_WEB_PORT),
      });

      assert.deepStrictEqual(offsets, {
        serverOffset: 1,
        webOffset: 1,
        mobileWebOffset: 0,
      });
    }),
  );
});
