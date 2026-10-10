import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AccessModeInfoBanner, getAccessModeInfoDescription } from "./AccessModeInfoBanner";

function renderBanner(overrides: Partial<ComponentProps<typeof AccessModeInfoBanner>> = {}) {
  return renderToStaticMarkup(
    <AccessModeInfoBanner
      threadId="thread-1"
      provider="opencodeV2"
      runtimeMode="full-access"
      accessModeChangeId={0}
      {...overrides}
    />,
  );
}

describe("AccessModeInfoBanner", () => {
  it("does not render before an explicit access-mode change", () => {
    expect(renderBanner()).toBe("");
  });

  it.each(["codex", "claudeAgent", "opencode"] as const)(
    "does not render for %s, even with a change notification",
    (provider) => {
      expect(renderBanner({ provider, accessModeChangeId: 1 })).toBe("");
    },
  );

  it("describes Supervised without unrelated mode details", () => {
    expect(getAccessModeInfoDescription("approval-required")).toBe(
      "Supervised asks before actions.",
    );
  });

  it("describes shared auto-accept behavior without asserting helper restrictions", () => {
    expect(getAccessModeInfoDescription("auto-accept-edits")).toBe(
      "Auto-accept edits permits native file edits; other actions still ask.",
    );
  });

  it("explains isolated auto edits with conditional helper availability", () => {
    expect(getAccessModeInfoDescription("auto-accept-edits", "isolated")).toContain(
      "only bounded canonical file edits; other actions still ask.",
    );
    expect(getAccessModeInfoDescription("auto-accept-edits", "isolated")).toContain(
      "If the bounded file helper is unavailable, native edits still ask.",
    );
  });

  it.each(["shared", "isolated"] as const)(
    "preserves the %s Full access trust explanation",
    (connectionMode) => {
      expect(getAccessModeInfoDescription("full-access", connectionMode)).toContain(
        "host-user filesystem, process and network access—not a sandbox.",
      );
    },
  );
});
