import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AccessModeInfoBanner } from "./AccessModeInfoBanner";

function renderBanner(overrides: Partial<ComponentProps<typeof AccessModeInfoBanner>> = {}) {
  return renderToStaticMarkup(
    <AccessModeInfoBanner
      threadId="thread-1"
      provider="opencodeV2"
      runtimeMode="full-access"
      {...overrides}
    />,
  );
}

describe("AccessModeInfoBanner", () => {
  it.each(["approval-required", "auto-accept-edits", "full-access"] as const)(
    "initially renders %s as neutral, nonurgent information",
    (runtimeMode) => {
      const markup = renderBanner({ runtimeMode });
      expect(markup).toContain('role="status"');
      expect(markup).not.toContain('role="alert"');
      expect(markup).toContain("bg-transparent");
      expect(markup).toContain('class="text-foreground"');
      expect(markup).not.toContain("text-warning");
      expect(markup).not.toContain("bg-warning");
      expect(markup).not.toContain("bg-info");
      expect(markup).toContain("Dismiss access information");
    },
  );

  it.each(["codex", "claudeAgent", "opencode"] as const)("does not render for %s", (provider) => {
    expect(renderBanner({ provider })).toBe("");
  });

  it.each(["shared", "isolated"] as const)(
    "explains Supervised for %s without unrelated mode descriptions",
    (connectionMode) => {
      const markup = renderBanner({ runtimeMode: "approval-required", connectionMode });
      expect(markup).toContain("Access: Supervised");
      expect(markup).toContain("Supervised asks before actions.");
      expect(markup).not.toContain("Auto-accept edits permits");
      expect(markup).not.toContain("Full access trusts");
      expect(markup).toContain("External-directory requests still ask.");
    },
  );

  it("defaults to shared native edit behavior without asserting helper restrictions", () => {
    const markup = renderBanner({ runtimeMode: "auto-accept-edits" });
    expect(markup).toContain(
      "Auto-accept edits permits native file edits; other actions still ask.",
    );
    expect(markup).not.toContain("bounded");
    expect(markup).not.toContain("Synthetic remote workspaces");
  });

  it("explains isolated auto edits with conditional helper availability", () => {
    const markup = renderBanner({ runtimeMode: "auto-accept-edits", connectionMode: "isolated" });
    expect(markup).toContain("only bounded canonical file edits; other actions still ask.");
    expect(markup).toContain("If the bounded file helper is unavailable, native edits still ask.");
    expect(markup).toContain("Synthetic remote workspaces never gain native file or shell access.");
    expect(markup).not.toContain("permits native file edits");
  });

  it.each(["shared", "isolated"] as const)(
    "preserves the host-user trust explanation for %s Full access",
    (connectionMode) => {
      const markup = renderBanner({ connectionMode });
      expect(markup).toContain("Access: Full access");
      expect(markup).toContain("host-user filesystem, process and network access—not a sandbox.");
      expect(markup).toContain("External-directory requests still ask.");
      if (connectionMode === "isolated") {
        expect(markup).toContain("In co-located workspaces, Full access");
        expect(markup).toContain(
          "Synthetic remote workspaces never gain native file or shell access.",
        );
      } else {
        expect(markup).not.toContain("Synthetic remote workspaces");
      }
    },
  );
});
