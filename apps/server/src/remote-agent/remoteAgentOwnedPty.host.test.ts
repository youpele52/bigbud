import { describe, expect, it } from "vitest";

import { profileOwner } from "./remoteAgentOwnedPty.profile.testUtils.ts";
import {
  recoveredRemoteAgentPtyHostFeatures,
  remoteAgentPtyHostFeatures,
} from "./remoteAgentOwnedPty.host.ts";
import { FakeLifecycleConnection } from "./remoteAgentPtyClient.lifecycle.testUtils.ts";

const v19 = new FakeLifecycleConnection();
const v18 = new FakeLifecycleConnection(["terminal.pty"]);
const owner = (hostFeatures?: { screen: boolean; lifecycle: boolean }) => ({
  ...profileOwner(),
  ...(hostFeatures ? { hostFeatures } : {}),
});

describe("per-PTY host features", () => {
  it("has a screen model and lifecycle state only when the create sent a lifecycle field", () => {
    expect(remoteAgentPtyHostFeatures({})).toEqual({ screen: false, lifecycle: false });
    expect(remoteAgentPtyHostFeatures({ lifecycleManaged: true })).toEqual({
      screen: true,
      lifecycle: true,
    });
    expect(remoteAgentPtyHostFeatures({ screenScrollbackRows: 1_000 })).toEqual({
      screen: true,
      lifecycle: true,
    });
  });

  it("a recovered PTY keeps what its create recorded, whatever this backend's flag says", () => {
    const managed = { lifecycleManaged: true, screenScrollbackRows: 1_000 };
    const none = { screen: false, lifecycle: false };
    const all = { screen: true, lifecycle: true };
    expect(recoveredRemoteAgentPtyHostFeatures(owner(none), v19, managed)).toEqual(none);
    expect(recoveredRemoteAgentPtyHostFeatures(owner(all), v19, undefined)).toEqual(all);
  });

  it("a row from before the field: what this creator would send over the connection", () => {
    // Flag off (remote composition without defaults) on a 1.9 agent: nothing.
    expect(recoveredRemoteAgentPtyHostFeatures(owner(), v19, undefined)).toEqual({
      screen: false,
      lifecycle: false,
    });
    // The local host always asks for lifecycle; an older agent never has it.
    const local = { lifecycleManaged: true, localLaunch: true };
    expect(recoveredRemoteAgentPtyHostFeatures(owner(), v19, local)).toEqual({
      screen: true,
      lifecycle: true,
    });
    expect(recoveredRemoteAgentPtyHostFeatures(owner(), v18, local)).toEqual({
      screen: false,
      lifecycle: false,
    });
  });
});
