import { describe, expect, it } from "vitest";
import { resolveFirstLaunchTourMode } from "./WelcomeTourDialog.firstLaunch";

const newInstall = {
  bootstrapComplete: true,
  hasLoadedServerConfig: true,
  hasSeenFileAccessPrompt: false,
  hasSeenWelcomeTour: false,
};

describe("first-launch welcome tour gating", () => {
  it("waits for bootstrap and the server config", () => {
    expect(resolveFirstLaunchTourMode({ ...newInstall, hasLoadedServerConfig: false })).toBeNull();
    expect(resolveFirstLaunchTourMode({ ...newInstall, bootstrapComplete: false })).toBeNull();
  });

  it("shows the whole tour to new installs", () => {
    expect(resolveFirstLaunchTourMode(newInstall)).toBe("tour");
  });

  it("never forces existing users who already answered File Access through it", () => {
    expect(resolveFirstLaunchTourMode({ ...newInstall, hasSeenFileAccessPrompt: true })).toBeNull();
    expect(
      resolveFirstLaunchTourMode({
        ...newInstall,
        hasSeenFileAccessPrompt: true,
        hasSeenWelcomeTour: true,
      }),
    ).toBeNull();
  });

  it("re-asks only the File Access question after its permissions were reset", () => {
    expect(resolveFirstLaunchTourMode({ ...newInstall, hasSeenWelcomeTour: true })).toBe(
      "file-access",
    );
  });
});
