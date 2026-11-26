import { describe, expect, it } from "vitest";

import {
  resolveSshOwnerActivation,
  resolveSshOwnerDrainIdentifiedRequest,
  sshOwnerActivationOverrideAllowed,
} from "./SshOwnerActivation.ts";
import {
  sshOwnerActivationDefine,
  sshOwnerActivationOverrideAllowedAtBuild,
} from "./SshOwnerActivation.build.ts";

const on = { BIGBUD_SSH_OWNER_ACTIVATION: "1" };

describe("SSH owner activation resolver", () => {
  it("defaults off, honours the env in a local build and ignores it in a release build", () => {
    expect(resolveSshOwnerActivation({ environment: {}, overrideAllowed: true })).toBe(false);
    expect(resolveSshOwnerActivation({ environment: on, overrideAllowed: true })).toBe(true);
    expect(resolveSshOwnerActivation({ environment: on, overrideAllowed: false })).toBe(false);
    expect(
      resolveSshOwnerActivation({
        environment: { BIGBUD_SSH_OWNER_ACTIVATION: "true" },
        overrideAllowed: true,
      }),
    ).toBe(false);
    // A source run (Vitest, `bun run dev`) has no bundle define and counts as local.
    expect(sshOwnerActivationOverrideAllowed()).toBe(true);
  });

  it("honours the explicit drain request only when activation is on", () => {
    const drain = { BIGBUD_SSH_OWNER_DRAIN_IDENTIFIED: "1" };
    expect(
      resolveSshOwnerDrainIdentifiedRequest({ environment: drain, overrideAllowed: true }),
    ).toBe(false);
    expect(
      resolveSshOwnerDrainIdentifiedRequest({
        environment: { ...on, ...drain },
        overrideAllowed: true,
      }),
    ).toBe(true);
    expect(
      resolveSshOwnerDrainIdentifiedRequest({
        environment: { ...on, ...drain },
        overrideAllowed: false,
      }),
    ).toBe(false);
  });

  it("bakes a release-safe bundle define: CI always off, local only by watch or opt-in", () => {
    const local = { BIGBUD_SSH_OWNER_ACTIVATION_LOCAL_BUILD: "1" };
    expect(sshOwnerActivationOverrideAllowedAtBuild(["tsdown"], {})).toBe(false);
    expect(sshOwnerActivationOverrideAllowedAtBuild(["tsdown"], local)).toBe(true);
    expect(sshOwnerActivationOverrideAllowedAtBuild(["tsdown", "--watch"], {})).toBe(true);
    expect(
      sshOwnerActivationOverrideAllowedAtBuild(["tsdown", "--watch"], { ...local, CI: "true" }),
    ).toBe(false);
    expect(
      sshOwnerActivationOverrideAllowedAtBuild(["tsdown"], { ...local, GITHUB_ACTIONS: "true" }),
    ).toBe(false);
    // The runtime env var alone never unlocks a bundle.
    expect(sshOwnerActivationDefine(["tsdown"], on)).toEqual({
      __BIGBUD_SSH_OWNER_ACTIVATION_OVERRIDE_ALLOWED__: "false",
    });
  });
});
