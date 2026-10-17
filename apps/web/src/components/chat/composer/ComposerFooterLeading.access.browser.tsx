import "../../../index.css";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import type { ProviderKind, RuntimeMode, ModelSelection } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { getCustomModelOptionsByProvider } from "../../../models/provider";
import { ComposerFooterLeading } from "./ComposerFooterLeading";

for (const provider of ["opencodeV2", "codex"] as const satisfies readonly ProviderKind[]) {
  for (const selected of ["approval-required", "auto-accept-edits", "full-access"] as const) {
    it(`actual ${provider} footer preserves ${selected} until an explicit menu choice and retains model identity`, async () => {
      const selection: ModelSelection = {
        provider,
        model: "synthetic",
        ...(provider === "opencodeV2" ? { subProviderID: "synthetic-provider" } : {}),
      };
      const changes: { modelSelection: ModelSelection; runtimeMode: RuntimeMode }[] = [];
      const onModel = vi.fn();
      const host = document.createElement("div");
      document.body.append(host);
      const screen = await render(
        <ComposerFooterLeading
          selectedProvider={provider}
          selectedModelForPickerWithCustomFallback={selection.model}
          lockedProvider={provider}
          providerStatuses={[]}
          modelOptionsByProvider={getCustomModelOptionsByProvider(
            DEFAULT_UNIFIED_SETTINGS,
            [],
            provider,
            selection.model,
          )}
          composerProviderState={{}}
          hasThreadStarted={false}
          planCardOpen={false}
          planCardLabel="Plan"
          interactionMode="default"
          runtimeMode={selected}
          compact
          providerTraitsMenuContent={null}
          onOpenOrchestra={vi.fn()}
          onProviderModelSelect={onModel}
          onProviderUnlock={vi.fn()}
          onToggleInteractionMode={vi.fn()}
          onTogglePlanCard={vi.fn()}
          onRuntimeModeChange={(mode) =>
            changes.push({ modelSelection: selection, runtimeMode: mode })
          }
        />,
        { container: host },
      );
      try {
        expect(changes).toEqual([]);
        await page.getByLabelText("More composer controls").click();
        const names = {
          "approval-required": "Supervised",
          "auto-accept-edits": "Auto-accept edits",
          "full-access": "Full access",
        };
        await expect
          .element(page.getByRole("menuitemradio", { name: names[selected], exact: true }))
          .toHaveAttribute("aria-checked", "true");
        for (const name of Object.values(names))
          await expect
            .element(page.getByRole("menuitemradio", { name, exact: true }))
            .not.toHaveAttribute("aria-disabled", "true");
        await expect
          .element(
            page.getByText(/Synthetic remote workspaces never gain native file or shell access/),
          )
          .not.toBeInTheDocument();
        const next = selected === "full-access" ? "approval-required" : "full-access";
        await page.getByRole("menuitemradio", { name: names[next], exact: true }).click();
        expect(changes).toEqual([{ modelSelection: selection, runtimeMode: next }]);
        expect(onModel).not.toHaveBeenCalled();
      } finally {
        await screen.unmount();
        host.remove();
      }
    });
  }
}
