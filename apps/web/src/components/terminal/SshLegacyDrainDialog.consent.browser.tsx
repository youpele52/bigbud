import "../../index.css";

import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SshLegacyDrainDialog } from "./SshLegacyDrainDialog";
import type { SshLegacyDrainFlow } from "./SshLegacyDrainDialog.types";

/** One accepted decision; later decisions are refused like the server registry. */
function decisions() {
  const accepted: string[] = [];
  return {
    accepted,
    decide(decision: "cancel" | "save-and-close" | "drain-now") {
      if (accepted.length > 0) return "refused";
      accepted.push(decision);
      return "accepted";
    },
  };
}

function flow(consent: ReturnType<typeof decisions>): SshLegacyDrainFlow {
  return {
    phase: "review",
    reason: "startup-refusal",
    panes: [
      {
        paneId: "thread-a:terminal-a",
        threadId: "thread-a",
        threadTitle: "Parser work",
        paneTitle: "direct ssh",
        route: "builder@host",
      },
      {
        paneId: "thread-b:terminal-b",
        threadId: "thread-b",
        threadTitle: "Release work",
        paneTitle: "remote agent",
        route: "builder@host-two",
      },
    ],
    saveAndClose: vi.fn(() => consent.decide("save-and-close")),
    drainNow: vi.fn(() => consent.decide("drain-now")),
    cancel: vi.fn(() => consent.decide("cancel")),
    retry: vi.fn(),
  };
}

describe("SSH drain consent decisions", () => {
  it("renders the real pane set and accepts exactly one decision", async () => {
    const consent = decisions();
    const view = flow(consent);
    const screen = await render(<SshLegacyDrainDialog flow={view} />);
    await expect.element(screen.getByText("Parser work")).toBeVisible();
    await expect.element(screen.getByText("Release work")).toBeVisible();
    await expect.element(screen.getByText("builder@host-two")).toBeVisible();
    await screen.getByRole("button", { name: "Drain identified panes" }).click();
    expect(consent.accepted).toEqual(["drain-now"]);
    expect(consent.decide("cancel")).toBe("refused");
    expect(consent.accepted).toEqual(["drain-now"]);
  });

  it("cancel closes without closing panes or accepting a later decision", async () => {
    const consent = decisions();
    const view = flow(consent);
    const screen = await render(<SshLegacyDrainDialog flow={view} />);
    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(consent.accepted).toEqual(["cancel"]);
    expect(view.drainNow).not.toHaveBeenCalled();
    expect(view.saveAndClose).not.toHaveBeenCalled();
    expect(consent.decide("drain-now")).toBe("refused");
  });
});
