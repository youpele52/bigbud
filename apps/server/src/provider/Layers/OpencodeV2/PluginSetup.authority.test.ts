import { mkdir, lstat } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts";
import { expect, it, vi } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { makeTestSettings } from "../../../ws/serverSettings.testing.ts";
import { makeV2AutomaticPluginSetup } from "./PluginSetup.native.ts";
import { V2ConsentAuthority } from "./Application.consent.ts";
import { runAuthorizedV2, runV2RequestContext } from "./Client.guard.ts";
import { deferred } from "./Test.fixtures.ts";
import type { OpencodeV2Client } from "./Client.ts";
import { makeV2SyntheticNativeEligibility } from "./NativeCompatibility.runtime.fixture.ts";

it("missing/health/old consent authority cannot read native config or install; root changes synchronously fence late awaited setup", async () => {
  const app = await makeV2ThreadPluginFixture();
  const root = path.join(app.root, "native-config");
  await mkdir(root);
  const settings = await Effect.runPromise(
    makeTestSettings({
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        opencodeV2: {
          enabled: true,
          binaryPath: "",
          profileRoot: "",
          nativeServiceTrust: "host-user-v1",
          nativePluginConfigRoot: root,
        },
      },
    }),
  );
  const consent = new V2ConsentAuthority(settings);
  try {
    const get = vi.fn(async () => [{ type: "directory", path: root }]);
    const list = vi.fn(async () => ({ data: [] }));
    const info = vi.fn(async () => ({ version: "2.0.26" }));
    const client = {
      config: { get },
      plugin: { list },
      server: { info },
    } as unknown as OpencodeV2Client;
    const setup = makeV2AutomaticPluginSetup(
      settings,
      consent,
      undefined,
      makeV2SyntheticNativeEligibility(client, app.artifact, root),
    );
    await expect(
      runAuthorizedV2(consent, "owned-transport", () => setup(app.artifact, client, "/worktree")),
    ).rejects.toThrow("expanded native trust");
    expect(info).not.toHaveBeenCalled();
    await Effect.runPromise(
      settings.updateSettings({
        providers: { opencodeV2: { nativeServiceTrust: "managed-thread-tools-v2" } },
      }),
    );
    await expect(setup(app.artifact, client, "/worktree")).rejects.toThrow("expanded native trust");
    const health = consent.capture(true);
    await expect(
      runV2RequestContext({ permit: health, transport: "owned-transport", intent: "health" }, () =>
        setup(app.artifact, client, "/worktree"),
      ),
    ).rejects.toThrow("expanded native trust");
    health.release();
    expect(get).not.toHaveBeenCalled();
    const entered = deferred<void>();
    const held = deferred<{ data: [] }>();
    list.mockImplementation(async () => {
      entered.resolve();
      return held.promise;
    });
    const pending = runAuthorizedV2(consent, "owned-transport", () =>
      setup(app.artifact, client, "/worktree"),
    );
    const rejected = expect(pending).rejects.toThrow();
    await entered.promise;
    await Effect.runPromise(
      settings.updateSettings({
        providers: {
          opencodeV2: { nativePluginConfigRoot: path.join(app.root, "another-native-root") },
        },
      }),
    );
    held.resolve({ data: [] });
    await rejected;
    await expect(lstat(path.join(root, "plugins"))).rejects.toThrow();
    expect(list).toHaveBeenCalledTimes(1);
  } finally {
    consent.close();
    await app.close();
  }
});
