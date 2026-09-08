import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SidebarRemoteAgentInstallDialog } from "./SidebarRemoteAgentInstallDialog";

describe("SidebarRemoteAgentInstallDialog", () => {
  it("describes a same-version rebuild as a build replacement", async () => {
    await render(
      <SidebarRemoteAgentInstallDialog
        request={{
          kind: "upgrade",
          candidate: {
            displayName: "Remote project",
            host: "example",
            username: "",
            port: "",
            workspaceRoot: "/srv/project",
            sshKeyPath: "",
            authMode: "ssh-key",
            providerRuntimeLocation: "remote",
          },
          executionTargetId: "ssh:example",
          targetLabel: "example",
          currentVersion: "0.2.0",
          targetVersion: "0.2.0",
        }}
        onDecline={vi.fn()}
        onInstalled={vi.fn()}
      />,
    );

    await expect.element(page.getByText(/replace the current remote agent build/)).toBeVisible();
    expect(page.getByText(/from 0\.2\.0 to 0\.2\.0/).query()).toBeNull();
  });
});
