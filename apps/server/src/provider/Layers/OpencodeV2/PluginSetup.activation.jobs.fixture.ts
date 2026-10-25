import * as Effect from "effect/Effect";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/settings";
import { V2ConsentAuthority } from "./Application.consent.ts";
import { makeTestSettings } from "../../../ws/serverSettings.testing.ts";
import type { V2ActivationJobScope } from "./PluginSetup.activation.jobs.ts";

/** Synthetic authority only; no descriptor discovery, native reads or service connection. */
export async function makeV2ActivationJobsFixture() {
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
        },
      },
    }),
  );
  const consent = new V2ConsentAuthority(settings);
  const scope = {
    root: "/fixture/root",
    issuer: "a".repeat(64),
    transport: "owned-test",
    generation: "generation",
    digest: "b".repeat(64),
    consentRevision: consent.currentRevision(),
    descriptor: {},
  } as V2ActivationJobScope;
  return { settings, consent, scope };
}
