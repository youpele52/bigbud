import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServicePathDiscovery } from "./servicePath.ts";
import {
  currentProviderServicePath,
  prepareProviderServicePath,
  resetProviderServicePathForTest,
} from "./servicePath.runtime.ts";

const discovered: ServicePathDiscovery = {
  path: "/home/u/.nvm/versions/node/v22/bin:/usr/bin",
  entries: [
    { dir: "/home/u/.nvm/versions/node/v22/bin", source: "versionManager", manager: "nvm" },
    { dir: "/usr/bin", source: "inherited" },
  ],
  shell: { status: "skipped" },
};

afterEach(() => resetProviderServicePathForTest());

describe("provider service PATH", () => {
  it("service PATH used in remote mode only", async () => {
    const remoteEnv: NodeJS.ProcessEnv = { PATH: "/srv/node:/usr/bin" };
    const discover = vi.fn(() => Effect.succeed(discovered));
    const fixPath = vi.fn();
    const remote = await Effect.runPromise(
      prepareProviderServicePath("remote", { env: remoteEnv, discover, fixPath }),
    );
    expect(remote).toBe("discovered");
    expect(discover).toHaveBeenCalledTimes(1);
    expect(fixPath).not.toHaveBeenCalled();
    expect(remoteEnv.PATH).toBe(discovered.path);
    const resolved = await Effect.runPromise(currentProviderServicePath("remote"));
    expect(resolved).toEqual({ source: "discovered", discovery: discovered });

    resetProviderServicePathForTest();
    for (const mode of ["desktop", "web"]) {
      const localEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
      const localDiscover = vi.fn(() => Effect.succeed(discovered));
      const localFix = vi.fn();
      const local = await Effect.runPromise(
        prepareProviderServicePath(mode, {
          env: localEnv,
          discover: localDiscover,
          fixPath: localFix,
        }),
      );
      expect(local).toBe("inherited");
      expect(localFix).toHaveBeenCalledTimes(1);
      expect(localDiscover).not.toHaveBeenCalled();
      expect(localEnv.PATH).toBe("/usr/bin");
      // Local resolution never reuses a remote discovery and never spawns a login shell.
      expect((await Effect.runPromise(currentProviderServicePath(mode))).source).toBe("inherited");
    }
  });
});
