import { mkdir } from "node:fs/promises";
import path from "node:path";
import * as Effect from "effect/Effect";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/settings";
import { expect, it, vi } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { makeTestSettings } from "../../../ws/serverSettings.testing.ts";
import { makeV2AutomaticPluginSetup } from "./PluginSetup.native.ts";
import { V2ConsentAuthority } from "./Application.consent.ts";
import { runAuthorizedV2 } from "./Client.guard.ts";
import { makeV2SyntheticNativeEligibility } from "./NativeCompatibility.runtime.fixture.ts";
import type { OpencodeV2Client } from "./Client.ts";
import * as Publication from "./PluginSetup.publication.ts";

it.skipIf(process.platform === "win32")(
  "Linux and macOS x64 reach guarded publication rather than the obsolete macOS ARM64 version gate",
  async () => {
    const app = await makeV2ThreadPluginFixture();
    const root = path.join(app.root, "native-config");
    await mkdir(root, { mode: 0o700 });
    const settings = await Effect.runPromise(
      makeTestSettings({
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          opencodeV2: {
            enabled: true,
            binaryPath: "",
            profileRoot: "",
            nativeServiceTrust: "managed-thread-tools-v2",
            nativePluginConfigRoot: root,
          },
        },
      }),
    );
    const consent = new V2ConsentAuthority(settings);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
    const publish = vi
      .spyOn(Publication, "publishV2ManagedPlugin")
      .mockRejectedValue(
        Object.assign(new Error("private path must not escape"), { code: "EACCES" }),
      );
    try {
      const client = {
        config: { get: async () => [{ type: "directory", path: root }] },
        plugin: { list: async () => ({ data: [] }) },
        server: { info: async () => ({ version: "2.0.29" }) },
      } as unknown as OpencodeV2Client;
      const setup = makeV2AutomaticPluginSetup(
        settings,
        consent,
        undefined,
        makeV2SyntheticNativeEligibility(client, app.artifact, root),
      );
      for (const os of ["linux", "darwin"]) {
        Object.defineProperty(process, "platform", { ...platform, value: os });
        Object.defineProperty(process, "arch", { ...arch, value: "x64" });
        await expect(
          runAuthorizedV2(consent, "fixture", () => setup(app.artifact, client, root)),
        ).rejects.toThrow("V2 setup failed at publication (EACCES)");
      }
      expect(publish).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(process, "platform", platform);
      Object.defineProperty(process, "arch", arch);
      vi.restoreAllMocks();
      consent.close();
      await app.close();
    }
  },
);
