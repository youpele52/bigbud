import { Effect } from "effect";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts";
import { expect, it, vi } from "vitest";
import { makeTestSettings } from "../../../ws/serverSettings.testing.ts";
import { V2ConsentAuthority } from "./Application.consent.ts";
import { assertV2RequestContext, runV2RequestContext } from "./Client.guard.ts";

it("host-user-v1 and health permits confer no native-config authority; expanded acknowledgement is separately revocable", async () => {
  const settings = await Effect.runPromise(
    makeTestSettings({
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        opencodeV2: { enabled: true, connectionMode: "shared", nativeServiceTrust: "host-user-v1" },
      },
    }),
  );
  const consent = new V2ConsentAuthority(settings),
    first = consent.capture(),
    issued = vi.fn();
  const check = (permit: ReturnType<V2ConsentAuthority["capture"]>) =>
    runV2RequestContext({ permit, transport: "fixture", intent: "execute" }, () => {
      assertV2RequestContext("fixture", new URL("http://127.0.0.1:49991/api/config"), "GET");
      issued();
    });
  try {
    expect(() => check(first)).toThrow("expanded managed-plugin acknowledgement");
    expect(issued).not.toHaveBeenCalled();
    await Effect.runPromise(
      settings.updateSettings({
        providers: { opencodeV2: { nativeServiceTrust: "managed-thread-tools-v2" } },
      }),
    );
    const expanded = consent.capture(),
      health = consent.capture(true);
    try {
      expect(() => check(expanded)).not.toThrow();
      expect(() => check(health)).toThrow("expanded managed-plugin acknowledgement");
      await Effect.runPromise(
        settings.updateSettings({
          providers: { opencodeV2: { nativeServiceTrust: "host-user-v1" } },
        }),
      );
      expect(() => check(expanded)).toThrow("revision changed");
      const current = consent.capture();
      try {
        expect(() => check(current)).toThrow("expanded managed-plugin acknowledgement");
      } finally {
        current.release();
      }
    } finally {
      expanded.release();
      health.release();
    }
    expect(issued).toHaveBeenCalledTimes(1);
  } finally {
    first.release();
    consent.close();
  }
});
