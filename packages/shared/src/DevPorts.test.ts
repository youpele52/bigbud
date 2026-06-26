import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  DEFAULT_MOBILE_WEB_PORT,
  DEFAULT_SERVER_PORT,
  DEFAULT_WEB_PORT,
  devPortsForOffset,
} from "./DevPorts";

describe("DevPorts", () => {
  it.effect("returns base ports for offset zero", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(devPortsForOffset(0), {
        serverPort: DEFAULT_SERVER_PORT,
        webPort: DEFAULT_WEB_PORT,
        mobileWebPort: DEFAULT_MOBILE_WEB_PORT,
      });
    }),
  );

  it.effect("shifts all dev ports together", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(devPortsForOffset(5), {
        serverPort: DEFAULT_SERVER_PORT + 5,
        webPort: DEFAULT_WEB_PORT + 5,
        mobileWebPort: DEFAULT_MOBILE_WEB_PORT + 5,
      });
    }),
  );
});
