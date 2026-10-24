import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { getWsConnectionStatus } from "../rpc/wsConnectionState";
import { WebSocketBlockingState } from "./WebSocketConnectionSurface.blocking";

describe("blocking backend ownership failures", () => {
  it.each(["state_directory_in_use", "state_directory_owner_unverified"] as const)(
    "shows actionable recovery for %s instead of ineffective connection actions",
    async (failureReason) => {
      const screen = await render(
        <WebSocketBlockingState
          desktopStartup={{
            status: "failed",
            failureReason,
            generation: 1,
            startedAt: 0,
          }}
          status={getWsConnectionStatus()}
          uiState="error"
        />,
      );
      await expect.element(screen.getByText("Local backend startup blocked")).toBeVisible();
      await expect
        .element(
          screen.getByText("Close the other bigbud app or backend, then quit and reopen this app."),
        )
        .toBeVisible();
      await expect
        .element(screen.getByRole("button", { name: "Reconnect", exact: true }))
        .not.toBeInTheDocument();
      await expect
        .element(screen.getByRole("button", { name: "Reload app", exact: true }))
        .not.toBeInTheDocument();
      expect(document.body.textContent).not.toContain("Reload the app to try again");
      if (failureReason === "state_directory_owner_unverified") {
        expect(document.body.textContent).toContain(
          "Confirm all backends using that data are stopped",
        );
      }
    },
  );
});
