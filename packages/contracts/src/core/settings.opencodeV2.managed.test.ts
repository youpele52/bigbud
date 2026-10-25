import { Schema } from "effect";
import { expect, it } from "vitest";
import { OpencodeV2DevelopmentSettings } from "./settings.opencodeV2";
import { ServerSettingsPatch } from "./settings.serverPatch";
import { DEFAULT_SERVER_SETTINGS, ServerSettings } from "./settings";

it("decodes old trust without expanding it and roundtrips explicit managed trust/config-root independently of cwd", () => {
  const decode = Schema.decodeUnknownSync(OpencodeV2DevelopmentSettings);
  expect(decode({ nativeServiceTrust: "host-user-v1" }).nativeServiceTrust).toBe("host-user-v1");
  expect(decode({}).nativePluginConfigRoot).toBeUndefined();
  const input = {
    nativeServiceTrust: "managed-thread-tools-v2",
    nativePluginConfigRoot: " /native/config ",
  };
  const settings = decode(input);
  expect(settings.nativePluginConfigRoot).toBe("/native/config");
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(OpencodeV2DevelopmentSettings))(
      JSON.stringify(settings),
    ),
  ).toEqual(settings);
  const patch = Schema.decodeUnknownSync(ServerSettingsPatch)({ providers: { opencodeV2: input } });
  expect(patch.providers?.opencodeV2).toEqual({
    nativeServiceTrust: "managed-thread-tools-v2",
    nativePluginConfigRoot: "/native/config",
  });
  expect(
    Schema.decodeUnknownSync(ServerSettingsPatch)({
      providers: { opencodeV2: { nativePluginConfigRoot: "" } },
    }).providers?.opencodeV2?.nativePluginConfigRoot,
  ).toBe("");
  expect(() => decode({ nativePluginConfigRoot: "relative" })).toThrow();
  expect(() => decode({ nativePluginConfigRoot: "/native\0bad" })).toThrow();
  const complete = {
    ...DEFAULT_SERVER_SETTINGS,
    providers: { ...DEFAULT_SERVER_SETTINGS.providers, opencodeV2: settings },
  };
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(ServerSettings))(JSON.stringify(complete)),
  ).toEqual(complete);
});
