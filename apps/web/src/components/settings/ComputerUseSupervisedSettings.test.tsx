import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComputerUseSupervisedSettings } from "./ComputerUseSupervisedSettings";
import type { SupervisedSettingsPort } from "./ComputerUseSupervisedSettings.logic";

const resolved = () => Promise.resolve();
const port = (view: SupervisedSettingsPort["view"]): SupervisedSettingsPort => ({
  view,
  applyPolicy: resolved,
  stop: resolved,
  resume: resolved,
});
const desired = {
  format: "bigbud.computerUsePolicy.v1",
  authorityId: "authority-1",
  revision: "2",
  enabled: true,
  disallowedApps: [
    { platform: "macos", kind: "bundle_id", value: "com.apple.Notes", label: "Notes" },
  ],
  defaultDeliveryMode: "background",
  checkInIntervalMs: 600_000,
  actionTimeoutMs: 900_000,
  diagnosticMetadataEnabled: false,
  digest: "c".repeat(64),
} as const;

describe("ComputerUseSupervisedSettings", () => {
  it("renders nothing under the legacy profile, even with a port", () => {
    expect(renderToStaticMarkup(<ComputerUseSupervisedSettings />)).toBe("");
    expect(
      renderToStaticMarkup(
        <ComputerUseSupervisedSettings
          profile="legacy"
          port={port({ kind: "ready", desired, native: { kind: "unavailable" } })}
        />,
      ),
    ).toBe("");
  });

  it("is inert and says so under v2 without a connected port", () => {
    const html = renderToStaticMarkup(<ComputerUseSupervisedSettings profile="v2" />);
    expect(html).toContain("App restrictions");
    expect(html).toContain("Not enforced: supervised control is not connected.");
    expect(html).toContain("Status unavailable: native control is not connected.");
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("shows desired restrictions with an honest pending state", () => {
    const html = renderToStaticMarkup(
      <ComputerUseSupervisedSettings
        profile="v2"
        port={port({
          kind: "ready",
          desired,
          native: {
            kind: "connected",
            latched: true,
            health: "paused",
            appliedRevision: "1",
            appliedDigest: "d".repeat(64),
            resumeChallenge: "challenge-1",
          },
        })}
      />,
    );
    expect(html).toContain("Notes");
    expect(html).toContain("Waiting for native acknowledgement of revision 2.");
    expect(html).toContain("Stopped. Resume is required to continue.");
    expect(html).toContain("Background");
  });
});
