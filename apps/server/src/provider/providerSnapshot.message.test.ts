import { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import { Schema } from "effect";
import { expect, it } from "vitest";

import { buildServerProvider } from "./providerSnapshot.ts";

it.each([
  [
    "  Failed to start the provider.\nListening on localhost.\n",
    "Failed to start the provider.\nListening on localhost.",
  ],
  ["\n\t ", undefined],
  ["Provider is ready.", "Provider is ready."],
  [undefined, undefined],
])(
  "encodes a provider probe message without breaking config subscriptions: %j",
  (message, expected) => {
    const snapshot = buildServerProvider({
      provider: "opencode",
      enabled: true,
      checkedAt: "2026-10-08T11:00:00.000Z",
      models: [],
      probe: {
        installed: true,
        version: "1.14.19",
        status: "warning",
        auth: { status: "unknown" },
        ...(message === undefined ? {} : { message }),
      },
    });
    expect(snapshot.message).toBe(expected);
    expect(Schema.encodeSync(ServerProvider)(snapshot)).toMatchObject({ provider: "opencode" });
  },
);
