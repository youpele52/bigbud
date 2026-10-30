import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProviderControlsSnapshot } from "@bigbud/contracts/server/providerControls";
import { ContextWindowRecoveryActions } from "./ContextWindowRecoveryActions";
import { ProviderMcpControls } from "./ProviderMcpControls";
import { COMPACT_LABELS, compactTone, controlsMatch } from "./ProviderSessionControls.logic";

describe("session maintenance presentation", () => {
  it("renders disabled compact with the authoritative reason", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowRecoveryActions
        handoffAvailable={false}
        onUseHandoff={() => {}}
        onCompact={() => {}}
        compactAvailable={false}
        compactReason="Native runtime is unqualified"
      />,
    );
    expect(markup).toContain("Compact context");
    expect(markup).toContain("disabled");
    expect(markup).toContain("Native runtime is unqualified");
  });
  it("labels reload-all scope and targeted operations as unavailable", () => {
    const markup = renderToStaticMarkup(
      <ProviderMcpControls
        snapshot={null}
        pending={false}
        onReload={() => {}}
        onRefresh={() => {}}
      />,
    );
    expect(markup).toContain("Reload all MCP servers");
    expect(markup).toContain("all configured MCP servers in this session");
    expect(markup).toContain("Targeted reconnect, toggle and replace are unavailable");
    expect(markup).toContain("disabled");
  });
  it.each(["submitted", "working", "completed", "failed", "unknown"] as const)(
    "distinguishes %s visually and in status text",
    (state) => {
      expect(COMPACT_LABELS[state]).toBeTruthy();
      expect(compactTone(state)).toContain(
        state === "completed"
          ? "green"
          : state === "failed"
            ? "red"
            : state === "unknown"
              ? "amber"
              : "blue",
      );
    },
  );
  it("rejects stale thread and epoch identities", () => {
    const snapshot = { threadId: "a", sessionEpoch: 2 } as ProviderControlsSnapshot;
    expect(controlsMatch(snapshot, "b", 2)).toBe(false);
    expect(controlsMatch(snapshot, "a", 3)).toBe(false);
    expect(controlsMatch(snapshot, "a", 2)).toBe(true);
  });
});
