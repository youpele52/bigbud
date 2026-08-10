import type { PluginInstallation } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  pluginDetailAction,
  pluginDetailActionLabel,
  pluginDetailActionRequiresConfirmation,
  pluginDetailMutationErrorTitle,
  pluginErrorDescription,
} from "./PluginDetailsPage.logic";

const installation: PluginInstallation = {
  pluginId: "openai-public:example",
  revision: "revision-a",
  installedAt: "2026-08-09T00:00:00Z",
};

describe("plugin detail actions", () => {
  it("distinguishes install, update, and uninstall semantics", () => {
    expect(pluginDetailAction("revision-a", undefined)).toBe("install");
    expect(pluginDetailAction("revision-b", installation)).toBe("update");
    expect(pluginDetailAction("revision-a", installation)).toBe("uninstall");
  });

  it("uses action-specific labels and mutation failure titles", () => {
    expect(pluginDetailActionLabel("update")).toBe("Update plugin");
    expect(pluginDetailMutationErrorTitle("install")).toBe("Could not install plugin");
    expect(pluginDetailMutationErrorTitle("update")).toBe("Could not update plugin");
    expect(pluginDetailMutationErrorTitle("uninstall")).toBe("Could not uninstall plugin");
  });

  it("requires destructive confirmation only for uninstall", () => {
    expect(pluginDetailActionRequiresConfirmation("install")).toBe(false);
    expect(pluginDetailActionRequiresConfirmation("update")).toBe(false);
    expect(pluginDetailActionRequiresConfirmation("uninstall")).toBe(true);
  });

  it("normalizes rejected RPC values for visible error feedback", () => {
    expect(pluginErrorDescription(new Error("offline"))).toBe("offline");
    expect(pluginErrorDescription("offline")).toBe("An error occurred.");
  });
});
