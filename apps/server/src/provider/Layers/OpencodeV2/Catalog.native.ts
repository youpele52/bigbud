import { setTimeout as delay } from "node:timers/promises";
import type { ModelRef } from "@opencode/client";
import { v2Request, type OpencodeV2Client } from "./Client.ts";

/** Native location/plugin settlement is asynchronous; bounded read-only retry never dispatches a prompt. */
export function readV2NativeCatalog(
  client: OpencodeV2Client,
  directory: string,
  options: {
    requested?: ModelRef;
    isClosed?: () => boolean;
    signal?: AbortSignal;
  } = {},
) {
  return v2Request(
    "model.list",
    async (signal) => {
      for (let attempt = 0; ; attempt++) {
        if (options.isClosed?.()) throw new Error("V2 discovery is closed.");
        const value = await client.model.list({ location: { directory } }, { signal });
        if (value.location.directory !== directory || value.data.length > 10_000)
          throw new Error("V2 native catalog ownership or size rejected.");
        const settled = options.requested
          ? value.data.some(
              (model) =>
                model.providerID === options.requested!.providerID &&
                model.id === options.requested!.id,
            )
          : value.data.length > 0;
        if (settled || attempt === 4) return value;
        await delay(250, undefined, { signal });
      }
    },
    options.signal ? { signal: options.signal } : {},
  );
}
