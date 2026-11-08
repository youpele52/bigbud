import { afterEach, describe, expect, it, vi } from "vitest";

import { makeRemoteAgentUpdateCoordinator } from "./remoteAgentUpdate.coordinator.ts";
import { installManagerFixture, source } from "./remoteAgentInstallManager.fixtures.ts";
import {
  configureSshTargetDisconnects,
  markSshTargetDisconnected,
} from "../ssh/sshTargetDisconnects.ts";

const flagged = "ssh:host=flagged&transport=agent";
const connected = "ssh:host=connected&transport=agent";

afterEach(() => configureSshTargetDisconnects(undefined, []));

describe("remote agent update coordinator with a disconnected target", () => {
  it("skips discovery and queued preparation quietly, before any SSH probe", async () => {
    const fixture = installManagerFixture();
    const openControl = vi.fn(async () => fixture.control);
    const hasReusableCredentials = vi.fn(() => false);
    const logger = vi.fn();
    const refresh = vi.fn(async () => source);
    const coordinator = makeRemoteAgentUpdateCoordinator({
      installManager: fixture.manager,
      loadInstallSource: Object.assign(async () => source, { refresh }),
      openControl,
      knownTargets: async () => [flagged, connected],
      hasReusableCredentials,
      logger,
    });
    await markSshTargetDisconnected(flagged);

    await coordinator.sourceChanged();
    coordinator.enqueue({ target: flagged, trigger: "scheduled" });
    coordinator.enqueue({ target: flagged, trigger: "authenticated", authenticated: true });
    coordinator.enqueue({ target: flagged, trigger: "slot-reclaimable" });
    await coordinator.drain();

    expect(hasReusableCredentials).toHaveBeenCalledWith(connected);
    expect(hasReusableCredentials).not.toHaveBeenCalledWith(flagged);
    expect(openControl).not.toHaveBeenCalled();
    expect(logger).not.toHaveBeenCalled();
  });
});
