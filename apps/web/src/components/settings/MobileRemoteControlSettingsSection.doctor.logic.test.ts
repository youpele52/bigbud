import type { DesktopTailscaleRemoteAccessStatus } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { resolveTailscaleDoctorSteps } from "./MobileRemoteControlSettingsSection.doctor.logic";

const healthy: DesktopTailscaleRemoteAccessStatus = {
  installed: true,
  running: true,
  online: true,
  serving: true,
  remoteBaseUrl: "https://desk.tail123.ts.net",
  error: null,
};

const states = (status: DesktopTailscaleRemoteAccessStatus) =>
  resolveTailscaleDoctorSteps(status).map((step) => `${step.id}:${step.state}`);

describe("resolveTailscaleDoctorSteps", () => {
  it("passes every host step and leaves the phone step to the phone", () => {
    expect(states(healthy)).toEqual([
      "installed:pass",
      "running:pass",
      "online:pass",
      "name:pass",
      "serve:pass",
      "phone:phone",
    ]);
    const name = resolveTailscaleDoctorSteps(healthy).find((step) => step.id === "name");
    expect(name?.detail).toBe("https://desk.tail123.ts.net");
  });

  it("stops at the first failure and marks later host steps as not checked", () => {
    expect(states({ ...healthy, online: false, serving: false })).toEqual([
      "installed:pass",
      "running:pass",
      "online:fail",
      "name:skipped",
      "serve:skipped",
      "phone:phone",
    ]);
  });

  it("explains a Serve failure with the host's own diagnosis", () => {
    const steps = resolveTailscaleDoctorSteps({
      ...healthy,
      serving: false,
      error: "Tailscale Serve points to 127.0.0.1:3000, which bigbud did not set up.",
    });
    expect(steps.find((step) => step.id === "serve")).toMatchObject({
      state: "fail",
      detail: "Tailscale Serve points to 127.0.0.1:3000, which bigbud did not set up.",
    });
  });

  it("reports a missing CLI as the first failure", () => {
    expect(states({ ...healthy, installed: false, running: false, online: false })[0]).toBe(
      "installed:fail",
    );
  });
});
