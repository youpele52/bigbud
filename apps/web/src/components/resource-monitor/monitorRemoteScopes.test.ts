import { describe, expect, it } from "vitest";
import type { ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import { availableMonitorScope, connectedRemoteMonitorScopes } from "./monitorRemoteScopes";

const project = (id: string, name: string, target: string) => ({
  projectId: id as ProjectId,
  name,
  target,
});

describe("connected remote monitor scopes", () => {
  it("disambiguates authorized duplicate workspace names without a client catalog", () => {
    const entries = [
      project("one", "VPS", "ssh:host=first"),
      project("two", "VPS", "ssh:host=second"),
      project("three", "Offline", "ssh:host=third"),
      project("local", "Local", "local"),
    ];
    const result = connectedRemoteMonitorScopes(entries.filter((entry) => entry.name === "VPS"));
    expect(result.map((entry) => entry.scope)).toEqual(["vps:one", "vps:two"]);
    expect(result[0]?.name).not.toBe(result[1]?.name);
    expect(result.map((entry) => entry.name)).toEqual(["VPS (one)", "VPS (two)"]);
    const sameHost = connectedRemoteMonitorScopes([
      project("one", "VPS", "ssh:host=first"),
      project("two", "VPS", "ssh:host=first"),
    ]);
    expect(sameHost.map((entry) => entry.name)).toEqual(["VPS (one)", "VPS (two)"]);
    expect(connectedRemoteMonitorScopes([])).toEqual([]);
    expect(availableMonitorScope("vps:one", result)).toBe("vps:one");
    expect(availableMonitorScope("vps:one", connectedRemoteMonitorScopes([]))).toBe("system");
  });
});
