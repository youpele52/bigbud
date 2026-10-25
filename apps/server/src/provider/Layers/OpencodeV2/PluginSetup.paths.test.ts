import { expect, it, vi } from "vitest";
import type { OpencodeV2Client } from "./Client.ts";
import { readV2PluginConfigScope } from "./PluginSetup.paths.ts";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { makeV2SyntheticNativeEligibility } from "./NativeCompatibility.runtime.fixture.ts";
import { V2NativeCompatibilityError } from "./NativeCompatibility.types.ts";
import { deferred } from "./Test.fixtures.ts";

it("source-profile checks cannot mistake another native root/project path for user-global; qualification precedes config reads", async () => {
  const app = await makeV2ThreadPluginFixture(),
    controller = new AbortController();
  const authority = {
    signal: controller.signal,
    assertCurrent: () => controller.signal.throwIfAborted(),
  };
  const get = vi.fn(async () => [{ type: "directory", path: "/native/config" }]);
  const client = { config: { get } } as unknown as OpencodeV2Client;
  try {
    const wrong = makeV2SyntheticNativeEligibility(client, app.artifact, "/wrong-config");
    await expect(
      readV2PluginConfigScope(client, "/worktree", "/wrong-config", authority, app.artifact, wrong),
    ).rejects.toThrow("source ordering");
    expect(get.mock.calls[0]).toEqual([
      { location: { directory: "/worktree" } },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ]);
    const eligibility = makeV2SyntheticNativeEligibility(client, app.artifact, "/native/config");
    expect(
      (
        await readV2PluginConfigScope(
          client,
          "/worktree",
          "/native/config",
          authority,
          app.artifact,
          eligibility,
        )
      ).entries,
    ).toEqual([{ type: "directory", path: "/native/config" }]);
    get.mockClear();
    await expect(
      readV2PluginConfigScope(
        client,
        "/worktree",
        "/native/config",
        authority,
        app.artifact,
        async () => {
          throw new V2NativeCompatibilityError(
            "native-qualification-required",
            "Native qualification is required.",
            "2.0.28",
          );
        },
      ),
    ).rejects.toThrow("qualification is required");
    expect(get).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it("scope revocation after an awaited native read prevents accepting late root evidence", async () => {
  const app = await makeV2ThreadPluginFixture(),
    controller = new AbortController();
  const authority = {
    signal: controller.signal,
    assertCurrent: () => controller.signal.throwIfAborted(),
  };
  const held = deferred<Array<{ type: string; path: string }>>(),
    entered = deferred<void>();
  const client = {
    config: {
      get: async () => {
        entered.resolve();
        return held.promise;
      },
    },
  } as unknown as OpencodeV2Client;
  try {
    const eligibility = makeV2SyntheticNativeEligibility(client, app.artifact, "/native/config");
    const pending = readV2PluginConfigScope(
      client,
      "/worktree",
      "/native/config",
      authority,
      app.artifact,
      eligibility,
    );
    const rejected = expect(pending).rejects.toThrow();
    await entered.promise;
    controller.abort();
    held.resolve([{ type: "directory", path: "/native/config" }]);
    await rejected;
  } finally {
    held.resolve([]);
    await app.close();
  }
});
