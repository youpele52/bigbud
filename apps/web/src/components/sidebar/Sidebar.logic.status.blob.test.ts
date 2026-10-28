import { describe, expect, it } from "vitest";

import { projectStatusBlobTone, type ThreadStatusPill } from "./Sidebar.logic.status";

const pill = (label: ThreadStatusPill["label"]): ThreadStatusPill => ({
  label,
  colorClass: "text-info-foreground",
  dotClass: "bg-info-foreground",
  pulse: true,
});

describe("projectStatusBlobTone", () => {
  it("uses the agent loader for live agent work", () => {
    expect(projectStatusBlobTone(pill("Working"))).toBe("agent");
    expect(projectStatusBlobTone(pill("Getting Ready"))).toBe("agent");
  });

  it("uses the violet subagent loader while only subagents work", () => {
    expect(projectStatusBlobTone(pill("Subagents Working"))).toBe("subagent");
  });

  it("keeps the plain dot for every non-working status", () => {
    for (const label of [
      "Compacting",
      "Done",
      "Failed",
      "Connection Warning",
      "Awaiting Input",
      "Plan Ready",
    ] as const) {
      expect(projectStatusBlobTone(pill(label))).toBeNull();
    }
  });
});
