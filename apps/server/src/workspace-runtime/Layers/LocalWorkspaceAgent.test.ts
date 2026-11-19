import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerConfig } from "../../startup/config.ts";
import { LocalWorkspaceAgent } from "../Services/LocalWorkspaceAgent.ts";
import { makeLocalWorkspaceAgentLayer } from "./LocalWorkspaceAgent.ts";

async function osIndexFlag(mode?: "desktop" | "web" | "remote"): Promise<boolean> {
  let flag: boolean | undefined;
  const layer = makeLocalWorkspaceAgentLayer((options) => {
    flag = options.osIndex;
    return {
      getConnection: async () => {
        throw new Error("unused");
      },
      getWorkspaceClient: async () => {
        throw new Error("unused");
      },
      close: () => undefined,
    };
  }).pipe(Layer.provide(mode ? Layer.succeed(ServerConfig, { mode } as never) : Layer.empty));
  await Effect.runPromise(
    Effect.scoped(Effect.asVoid(LocalWorkspaceAgent.asEffect())).pipe(Effect.provide(layer)),
  );
  return flag ?? false;
}

describe("LocalWorkspaceAgent layer", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("starts the agent with --os-index only for the desktop-embedded backend", async () => {
    expect(await osIndexFlag("desktop")).toBe(true);
    expect(await osIndexFlag("web")).toBe(false);
    expect(await osIndexFlag("remote")).toBe(false);
    expect(await osIndexFlag()).toBe(false);
  });

  it("honours the managed-device policy", async () => {
    vi.stubEnv("BIGBUD_SEARCH_THIS_COMPUTER", "0");
    expect(await osIndexFlag("desktop")).toBe(false);
  });
});
